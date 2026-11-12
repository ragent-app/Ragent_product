#!/usr/bin/env node
import { WORKBENCH_EXECUTION_POLICY, applyWorkbenchRunPolicy, buildWorkbenchCodexEnvironment } from '../lib/workbench-execution-policy.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'child_process';
import { accessSync, constants, rmSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { PassThrough } from 'node:stream';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'path';
import { ownerWindowsOsPaths } from '../lib/windows-owner-os-paths.mjs';
import { installWindowsRunCliShim } from './windows-run-cli-shim.mjs';
import { buildCodexRunShellEnvironment } from './codex-shared-environment.mjs';
import { MAC_CLEANUP_SPOOL_TYPE, macCancellationCleanupStatus, readMacCleanupNotification } from './macos-codex-cancellation.mjs';
import { evaluateRunBoundCodexWindowsHook } from './codex-run-bound-windows-hook.mjs';
import { buildSharedCodexWindowsHook } from './codex-shared-windows-hook.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import { createToolInvocation, prependAttachmentPaths, resolveCommandSpawnSpec } from './process-runner.mjs';
import { readPiTerminalOutcome } from './adapters/pi.mjs';
import { buildCodexAppServerProjectTrustArgs } from './adapters/codex-app-server.mjs';
import {
  CODEX_APP_SERVER_BROKER_SCRIPT,
  codexAppServerBrokerLockPath,
  codexAppServerBrokerSocketPath,
  codexBrokerAccountDigest,
  ensureCodexAppServerBroker,
} from './codex-app-server-broker.mjs';
import {
  prepareImplicitCodexAppServerModel,
  createCodexAccountModelCatalog,
} from './codex-app-server-default-model.mjs';
import { computeExecutionScopeDigest } from './execution-scope.mjs';
import { assertRunPublication, runPublicationError } from './run-publication-contract.mjs';
import { assertMessageRunBinding } from './message-run-contract.mjs';
import { assertRunLaunchBoundary } from './run-execution-boundary.mjs';
import {
  buildAcpStartInput,
  buildAcpSessionInput,
  isAcpInitializeAccepted,
  buildAcpPromptInput,
  buildAcpModeSwitchInput,
  acpAvailableModesFromResponse,
  isAcpModeSwitchAccepted,
  buildAcpUnattendedPermissionDenial,
  acpSessionIdFromResponse,
  acpResponseError,
} from './adapters/acp-stdio.mjs';
import { parseScopedCodexModel, readPreferredCodexModelFromConfig } from './models.mjs';
import { access, lstat, open, readFile, realpath } from 'fs/promises';
import { buildSandboxedSpawn, requireSandboxAvailability } from '../lib/runner-sandbox.mjs';
import { readOnlyWorkspaceForRun } from './read-only-run-sandbox.mjs';
import { openReadOnlyProviderSeeds, closeReadOnlyProviderSeeds, deliverReadOnlyProviderSeeds } from './read-only-provider-home.mjs';
import { createCodexReadOnlyEnvironmentSetup } from './codex-readonly-environment-setup.mjs';
import { startReadOnlyCodexExecutor } from './codex-readonly-executor.mjs';
import { createFileChangeStatsTracker } from './file-change-stats.mjs';
import {
  FILE_ASSET_ID_PATTERN,
  FILE_ASSET_INPUT_STAGING_SCHEMA_VERSION,
  FILE_ASSET_READ_EFFECTS,
  FILE_ASSET_READ_OPERATION,
} from './file-asset-input-contract.mjs';
import {
  computeSemanticManifestHash,
  validateSemanticOperation,
} from './semantic-operation.mjs';
import {
  buildCodexContextMetricsPayload,
  readLatestCodexSessionMetrics,
} from './codex-session-metrics.mjs';
import { codexRolloutAccountId, findAccountCodexRollout, findManagedCodexRollout } from './codex-managed-rollout.mjs';
import { codexRunBindingPath, verifyCodexRunBinding } from '../lib/provider-runtime/codex-run-binding.mjs';
import { assertCodexHomeNotFenced } from '../lib/provider-runtime/codex-home-fence.mjs';
import {
  buildCodexAppServerInitializeMessage,
  buildCodexAppServerInitializedNotification,
  buildCodexAppServerModelListMessage,
  CODEX_APP_SERVER_REQUEST_IDS,
  buildCodexAppServerThreadMessage,
  buildCodexAppServerTurnInterruptMessage,
  buildCodexAppServerTurnStartMessage,
  buildCodexAppServerTurnSteerMessage,
  buildCodexAppServerApprovalResponseMessage,
  readCodexAppServerManagedMcpRequest,
  buildCodexAppServerMcpServerStatusListMessage,
  buildCodexAppServerThreadGoalSetMessage,
  buildCodexAppServerThreadGoalClearMessage,
  evaluateCodexAppServerMcpReadiness,
  formatCodexAppServerApprovalDecision,
  isCodexAppServerRagentApprovalGateEnabled,
  isCodexAppServerEventForThread,
  isCodexAppServerTurnTerminalMessage,
  normalizeCodexAppServerApprovalDecision,
  readCodexAppServerApprovalRequest,
  readCodexAppServerEventTurnId,
  readCodexAppServerEventThreadId,
  readCodexAppServerMcpStartupStatus,
  readCodexAppServerMcpStatusList,
  readCodexAppServerThreadId,
  readCodexAppServerTurnId,
  validateCodexAppServerApprovalContext,
} from './codex-app-server-protocol.mjs';
import {
  buildClaudeBidiApprovalResponseMessage,
  describeManagedPrivilegeResponse,
  buildClaudeBidiManagedMcpResponse,
  buildClaudeBidiInitializeMessage,
  buildClaudeBidiInterruptMessage,
  buildClaudeBidiUserMessage,
  isClaudeBidiTurnTerminal,
  isClaudeBidiTurnError,
  readClaudeBidiControlResponse,
  readClaudeBidiApprovalRequest,
  readClaudeBidiManagedMcpRequest,
  isClaudeBidiMcpToolName,
  serializeClaudeBidiMessage,
} from './claude-bidi-protocol.mjs';
import { CHAT_PORT } from '../lib/config.mjs';
import { isManagedLearningProfileWrite } from './managed-memory-gate.mjs';
import { hasProviderCapability } from './provider-contract.mjs';
import {
  PRIVILEGED_GATE_DECISION,
  decidePrivilegedGate,
  decideRiskGate,
  isGatedPermissionMode,
  isUserFacingGateKind,
} from './privileged-gate.mjs';
import { decideWindowsApproval } from './windows-approval-gate.mjs';
import { buildClaudeWindowsRipgrepBridge, buildWindowsSelectStringGlobBridge, verifyCodexWindowsBoundSearchApproval } from './windows-ripgrep-bridge.mjs';
import { buildWindowsWildcardNameBridge, verifyCodexWindowsWildcardNameApproval } from './windows-wildcard-list-bridge.mjs';
import { buildClaudePosixCwdTransition, buildClaudePosixRipgrepBridge, observeClaudePosixCwdResult, buildClaudeWindowsDefaultFileToolBridge, buildClaudeWindowsRelativeOperationBridge } from './windows-claude-relative-operation-bridge.mjs';
import { buildClaudeWindowsInstallBridge, checkWindowsInstallBridgeReadiness } from './windows-auto-install-bridge.mjs';
import { buildWindowsCliAssetBridge, buildWindowsCliReadBridge } from './windows-cli-read-bridge.mjs';
import { needsWindowsElevationGuidance, windowsElevationGuidance, shouldInstallWindowsElevationHook } from './windows-elevation-guidance.mjs';
import { verifyCodexWindowsInstallBridgeApproval } from './codex-windows-install-hook.mjs';
import { createCodexManagedHookSetup } from './codex-managed-hook-setup.mjs';
import { buildWindowsSafeDeleteBridge } from './windows-safe-delete-bridge.mjs';
import { verifyCodexWindowsSafeDeleteApproval } from './codex-windows-safe-delete-hook.mjs';
import { verifyCodexWindowsCliAssetApproval, verifyCodexWindowsTriggerApproval } from './codex-windows-cli-asset-hook.mjs';
import { buildPrivilegedBatch } from './privileged-ops.mjs';
import {
  appendRunSpoolRecord,
  flushRunSpool,
  getRun,
  getRunManifest,
  isLinuxPeerResultRunner,
  linuxPeerResultClientOptions,
  readRunBrowserToken,
  readRunAuthRecoveryToken,
  readRunSessionControlToken,
  readRunSessionControlRenewalToken,
  runSessionControlRenewalCapabilityPath,
  readRunSpoolRecords,
  streamRunSpoolRecords,
  sessionBrowserProfileDir,
  runDir,
  updateRun,
  writeRunResult,
} from './runs.mjs';
import { classifyRunAuthFailure } from '../lib/provider-runtime/run-auth-recovery.mjs';
import { acquireNativeOAuthLock, adoptNativeOAuthLock } from '../lib/provider-runtime/oauth-lock.mjs';
import { resolveRunnableSessionFolder } from './session-folder.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import {
  assertWindowsManagedJob,
  terminateProviderProcessTree,
} from '../lib/windows-managed-spawn.mjs';
import {
  CODEX_FRESH_RECOVERY_ENV,
  spawnFreshCodexRecoverySidecar,
} from '../lib/runner-sidecar-recovery.mjs';
import {
  buildRunnerGuiBindPaths,
  pickRunnerGuiEnvironment,
  resolveRunnerAgyHomeDir,
  resolveRunnerCodexHomeDir,
} from '../lib/runner-env.mjs';
import {
  buildAgyRuntimeLaunchSpec,
  buildAgyStreamInput,
  isAgyRuntime,
} from '../lib/agy-runtime.mjs';
import { createClaudeThinkingTokenSampler } from './provider-spool-sampling.mjs';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';
import { bindWindowsRunExecutionIdentity } from './windows-run-identity.mjs';

const RUN_INPUT_VERIFY_CONCURRENCY = 4;

// Provider bootstrap reads are deliberately best-effort.  A per-run Codex
// home may not have been materialized yet (or auth.json may be rotated while
// a previous run is finishing); those conditions must select the normal
// non-OAuth path rather than crash the sidecar before it starts the provider.
async function readJsonIfPresent(path, readFileImpl = readFile) {
  try {
    return JSON.parse(await readFileImpl(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    return null;
  }
}

async function mapWithRunInputVerifyConcurrency(items, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 1) return Promise.all(list.map(mapper));
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(RUN_INPUT_VERIFY_CONCURRENCY, list.length),
  }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
import { applyManagedRuntimeEnv } from './runtime-policy.mjs';
import {
  hasPendingApprovedAction,
  hasPendingRuntimeApproval,
  hasPendingPrivilegedBatch,
} from './runner-idle-policy.mjs';
import { providerRequiresTerminalEvidence } from './run-terminal-signals.mjs';
import { waitForApprovedActionResolution } from './approved-action-wait.mjs';
import { waitForPrivilegedShimResolution } from './privileged-shim-wait.mjs';
import { shouldFallbackClaudeBidi } from './claude-bidi-fallback.mjs';
import { resolveClaudeResumeCwd } from './claude-resume-cwd.mjs';
import { runOpenHandsServiceSidecar } from './openhands-service-sidecar.mjs';
import { isPrivilegeRoutingEnabled } from './approved-action-policy.mjs';
import {
  applyPrivilegedShimSpawnEnv,
  startPrivilegedShimChannel,
} from './privileged-shim-listener.mjs';
import {
  BROWSER_MCP_ENV_KEYS,
  MCP_OVERLAY_ERROR_CODES,
  MCP_OVERLAY_MAX_ATTEMPTS,
  prepareCodexThreadMcp,
  prepareManagedMcpOverlay,
} from './approved-action-mcp-overlay.mjs';
import {
  isBrowserCapabilityExpired,
  supportsBrowserMcpRuntime,
  validateBrowserCapabilityChannel,
} from './browser-capability.mjs';
import { createWindowsJobObject } from '../lib/windows-job-object.mjs';
export { providerRequiresTerminalEvidence } from './run-terminal-signals.mjs';
import {
  isProviderNativeDelegationEvidence,
  reconcileProviderNativeDelegationRun,
} from './provider-native-delegation-runtime.mjs';
import {
  buildProviderLivenessSnapshot,
  resolveProviderHeartbeatIntervalMs,
  resolveProviderOutputIdleDiagnosticMs,
} from './provider-liveness.mjs';

// Provider-native delegation evidence can arrive in a burst (especially
// Codex app-server item updates). Replaying the whole bounded spool for every
// matching frame serializes stdout processing behind repeated disk scans and
// makes a busy run look stalled. Keep one coalescing state per sidecar Run;
// terminalization flushes it before the authoritative provider-exited replay.
const PROVIDER_NATIVE_DELEGATION_RECONCILE_DEBOUNCE_MS = 250;
const providerNativeDelegationReconcileStates = new Map();

function scheduleProviderNativeDelegationReconcile(runId, deps) {
  if (!runId || !deps || typeof deps.getRun !== 'function') return;
  const state = providerNativeDelegationReconcileStates.get(runId) || {
    timer: null,
    inFlight: null,
    queued: false,
    deps,
  };
  state.deps = deps;
  state.queued = true;
  providerNativeDelegationReconcileStates.set(runId, state);
  if (state.timer || state.inFlight) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!state.queued || state.inFlight) return;
    state.queued = false;
    state.inFlight = reconcileProviderNativeDelegationRun({
      runId,
      providerExited: false,
      nowMs: Date.now(),
      ...state.deps,
      protectedResultHandoff: isLinuxPeerResultRunner(),
    })
      .catch((error) => logSidecarDiagnostic(runId, 'Provider-native delegation evidence reconciliation failed', {
        error: normalizeErrorMessage(error),
      }))
      .finally(() => {
        state.inFlight = null;
        if (state.queued) scheduleProviderNativeDelegationReconcile(runId, state.deps);
      });
  }, PROVIDER_NATIVE_DELEGATION_RECONCILE_DEBOUNCE_MS);
  state.timer.unref?.();
}

async function flushProviderNativeDelegationReconcile(runId) {
  const state = providerNativeDelegationReconcileStates.get(runId);
  if (!state) return;
  while (true) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.queued && !state.inFlight) {
      state.queued = false;
      state.inFlight = reconcileProviderNativeDelegationRun({
        runId,
        providerExited: false,
        nowMs: Date.now(),
        ...state.deps,
        protectedResultHandoff: isLinuxPeerResultRunner(),
      })
        .catch((error) => logSidecarDiagnostic(runId, 'Provider-native delegation evidence reconciliation failed', {
          error: normalizeErrorMessage(error),
        }))
        .finally(() => {
          state.inFlight = null;
          if (state.queued) scheduleProviderNativeDelegationReconcile(runId, state.deps);
        });
    }
    if (state.inFlight) await state.inFlight;
    if (!state.queued && !state.inFlight && !state.timer) break;
  }
  providerNativeDelegationReconcileStates.delete(runId);
}

// ── cwd resolution (Execution-Scope slice 2, design section 6.5) ──────────
// New manifests with an immutable executionScope use ONLY
// executionScope.cwd.realPath: when that path is missing/inaccessible the Run
// fails with EXECUTION_SCOPE_UNAVAILABLE instead of silently falling back to
// the managed work root / home. Legacy manifests (no executionScope) keep the
// existing resolveRunnableSessionFolder fallback and are explicitly flagged
// legacyExecutionScope=true.
export function isRunnableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveRunCwd(manifest, deps = {}) {
  const canRunDir = typeof deps.isRunnableDirectory === 'function'
    ? deps.isRunnableDirectory
    : isRunnableDirectory;
  const resolveLegacy = typeof deps.resolveLegacy === 'function'
    ? deps.resolveLegacy
    : resolveRunnableSessionFolder;

  const scope = manifest?.executionScope;
  const scopeCwd = scope && typeof scope.cwd?.realPath === 'string' ? scope.cwd.realPath.trim() : '';
  if (scopeCwd) {
    if (canRunDir(scopeCwd)) {
      return {
        cwd: scopeCwd,
        requestedCwd: scopeCwd,
        repaired: false,
        reason: '',
        legacyExecutionScope: false,
      };
    }
    const error = new Error(`Execution scope cwd is not available on this host: ${scopeCwd}`);
    error.code = 'EXECUTION_SCOPE_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }

  const legacy = resolveLegacy(manifest?.folder);
  return {
    ...legacy,
    legacyExecutionScope: true,
  };
}

// Risk exceptions are valid only when they are part of the admission snapshot
// whose digest the sidecar received. A malformed or stale context deliberately
// falls back to the conservative classifier path instead of trusting cwd or
// projectRoot supplied by a caller.
export function resolveRunRiskContext(manifest, { platform = process.platform, windowsOsPaths = platform === 'win32' ? ownerWindowsOsPaths() : null } = {}) {
  const scope = manifest?.executionScope;
  if (!scope || typeof scope !== 'object') {
    return { riskContext: null, valid: false, reason: 'legacy-execution-scope' };
  }
  const context = scope.riskContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return { riskContext: null, valid: false, reason: 'risk-context-missing' };
  }
  const expectedDigest = typeof manifest.executionScopeDigest === 'string'
    ? manifest.executionScopeDigest.trim()
    : '';
  if (!expectedDigest) {
    return { riskContext: null, valid: false, reason: 'execution-scope-digest-missing' };
  }
  let actualDigest = '';
  try {
    actualDigest = computeExecutionScopeDigest(scope);
  } catch {
    return { riskContext: null, valid: false, reason: 'execution-scope-digest-invalid' };
  }
  if (actualDigest !== expectedDigest) {
    return { riskContext: null, valid: false, reason: 'execution-scope-digest-mismatch' };
  }
  if (context.schemaVersion !== 1
    || typeof context.trustedWorkspaceRoot !== 'string'
    || !context.trustedWorkspaceRoot.trim()
    || !Array.isArray(context.protectedRoots)) {
    return { riskContext: null, valid: false, reason: 'risk-context-shape-invalid' };
  }
  if (platform === 'win32') {
    if (context.platform !== 'win32' || !windowsOsPaths || !Array.isArray(context.systemPathRoots)) {
      return { riskContext: null, valid: false, reason: 'windows-system-paths-unavailable' };
    }
    if (context.programDataRoot !== undefined
      && (typeof context.programDataRoot !== 'string'
        || win32.normalize(context.programDataRoot).toLowerCase() !== win32.normalize(windowsOsPaths.programData).toLowerCase())) {
      return { riskContext: null, valid: false, reason: 'windows-program-data-root-mismatch' };
    }
    const roots = new Set(context.systemPathRoots.filter((value) => typeof value === 'string')
      .map((value) => win32.normalize(value).toLowerCase()));
    if (![windowsOsPaths.windows, windowsOsPaths.programData, windowsOsPaths.programFiles, windowsOsPaths.programFilesX86]
      .every((value) => typeof value === 'string' && value && roots.has(win32.normalize(value).toLowerCase()))) {
      return { riskContext: null, valid: false, reason: 'windows-system-paths-unavailable' };
    }
  }
  return { riskContext: context, valid: true, reason: '' };
}

const runId = process.argv[2];
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
// This file is both a CLI entry (node chat/runner-sidecar.mjs <runId>) and a
// source of importable pure helpers (resolveRunCwd / isRunnableDirectory for
// tests). Only run main() when invoked as the entry script; importing the
// module must not start a sidecar process.
const isMainEntry = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // interactive runs must fail fast when a provider stalls
const DEFAULT_KNOWN_HARNESS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_AGY_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours without output
const IDLE_CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds
// An app-server turn can legitimately stay silent while the model is doing
// long-context retrieval/reasoning.  The generic interactive watchdog is only
// two minutes, which used to kill a healthy Codex turn and then report the
// misleading "exited before an accepted terminal turn event" error.  Keep a
// separate, bounded turn budget; operators/tests can override it explicitly.
const DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CODEX_TOOL_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // commands/builds may legitimately be quiet for several minutes
const DEFAULT_CODEX_IDLE_INTERRUPT_GRACE_MS = 5 * 1000;
const DEFAULT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 45 * 1000;
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 60 * 1000;
// Provider output is an ordered stream, but persisting every frame involves
// async filesystem work.  An unbounded Promise chain used to retain every
// queued JSON line (and its closure) when a provider produced output faster
// than the spool writer could flush it.  Keep a bounded amount in memory and
// apply backpressure to the provider stdout pipe instead of dropping protocol
// frames.  The values are intentionally generous enough for normal streaming
// while still putting a hard ceiling on sidecar memory.
const DEFAULT_PROVIDER_STDOUT_QUEUE_MAX_LINES = 2048;
const DEFAULT_PROVIDER_STDOUT_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROVIDER_STDOUT_LINE_MAX_BYTES = 8 * 1024 * 1024;
// A child can exit while a grandchild still holds the inherited stdout pipe
// open. Waiting forever for readline/stream EOF leaves terminalization stuck
// even though the provider process itself has already exited. Keep the drain
// barrier bounded; all frames observed before the deadline are still flushed.
const DEFAULT_PROVIDER_STDOUT_DRAIN_TIMEOUT_MS = 15 * 1000;
const CODEX_FRESH_RECOVERY_WAIT_MS = 2 * 60 * 1000;
// Codex app-server may hold mcpServerStatus/list behind an unrelated external
// MCP server that is still starting.  A managed AgentoC MCP that has emitted
// `ready` is safe to use; wait briefly for inventory schema verification, then
// fall back to that authoritative startup signal rather than blocking a turn.
const DEFAULT_CODEX_MCP_STARTUP_FALLBACK_MS = 1500;
const CODEX_APP_SERVER_TURN_RETRY_LIMIT = 3; // 空输出/上游错误自动重发 turn 的上限
const CODEX_APP_SERVER_TURN_RETRY_BACKOFF_BASE_MS = 3000; // 退避基数：第 n 次重试前等待 3*2^(n-1) 秒
let fatalSidecarTerminationInFlight = false;
let nativeOAuthLockHandle = null;
let nativeOAuthLockReleasePromise = null;
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Codex emits item/started before a command (or another tool item) can run and
// item/completed only after it returns.  The old idle watchdog looked solely at
// stdout timestamps, so a quiet but healthy command was killed after two
// minutes. Keep this list deliberately semantic: reasoning/agent-message items
// still use the normal provider-stall timeout, while actual tool execution gets
// its own longer bound.
function isCodexAppServerToolItemType(type) {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (!normalized) return false;
  return normalized.includes('command')
    || normalized.includes('mcp')
    || normalized.includes('tool')
    || normalized.includes('filechange')
    || normalized.includes('file_change')
    || normalized.includes('websearch')
    || normalized.includes('imagegeneration')
    || normalized.includes('computer');
}

function isCodexAppServerCurrentTurnEvent(state, parsed) {
  if (!isCodexAppServerStateEvent(state, parsed)) return false;
  const eventTurnId = readCodexAppServerEventTurnId(parsed);
  return !state.turnId || !eventTurnId || eventTurnId === state.turnId;
}

// The JSON-RPC schema normally repeats threadId on every notification, but
// older/newer app-server builds have emitted turn notifications with only the
// turn object. Once this sidecar has started a turn, a thread-less event can be
// safely correlated by turn id (or, before turn/started is observed, by the
// fact that it is the first event for the just-sent turn). Rejecting these
// frames as "foreign" leaves the Run alive with no output until the watchdog.
function isCodexAppServerStateEvent(state, parsed) {
  if (!state || !parsed) return false;
  if (isCodexAppServerEventForThread(parsed, state.threadId)) return true;
  const eventThreadId = readCodexAppServerEventThreadId(parsed);
  if (eventThreadId) return false;
  if (!state.startedTurn) return false;
  const eventTurnId = readCodexAppServerEventTurnId(parsed);
  return !state.turnId || !eventTurnId || eventTurnId === state.turnId;
}

export function observeCodexAppServerItem(state, parsed) {
  if (!isCodexAppServerCurrentTurnEvent(state, parsed)) return;
  if (!(state.activeItems instanceof Map)) state.activeItems = new Map();
  const method = typeof parsed?.method === 'string' ? parsed.method : '';
  if (method === 'item/fileChange/patchUpdated') {
    const itemId = typeof parsed?.params?.itemId === 'string' ? parsed.params.itemId.trim() : '';
    const previous = state.activeItems.get(itemId);
    if (previous && Array.isArray(parsed.params.changes)) {
      previous.changes = parsed.params.changes.map((change) => ({ path: change?.path, kind: change?.kind }));
    }
    return;
  }
  if (method !== 'item/started' && method !== 'item/completed') return;
  const item = parsed?.params?.item && typeof parsed.params.item === 'object'
    ? parsed.params.item
    : null;
  const itemId = typeof item?.id === 'string' && item.id.trim()
    ? item.id.trim()
    : typeof parsed?.params?.itemId === 'string' && parsed.params.itemId.trim()
      ? parsed.params.itemId.trim()
      : '';
  if (!itemId) return;
  if (method === 'item/completed') {
    state.activeItems.delete(itemId);
    return;
  }
  state.activeItems.set(itemId, {
    type: typeof item?.type === 'string' ? item.type : '',
    tool: isCodexAppServerToolItemType(item?.type),
    startedAtMs: Date.now(),
    ...(Array.isArray(item?.changes) ? { changes: item.changes.map((change) => ({ path: change?.path, kind: change?.kind })) } : {}),
  });
}

function hasActiveCodexAppServerToolItem(state) {
  if (!(state?.activeItems instanceof Map)) return false;
  return Array.from(state.activeItems.values()).some((item) => item?.tool === true);
}

function readPositiveDurationEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultIdleTimeoutForRuntime(runtimeFamily) {
  const family = typeof runtimeFamily === 'string' ? runtimeFamily.trim().toLowerCase() : '';
  if (
    family.endsWith('-acp')
    || family.endsWith('-json')
    || family.endsWith('-jsonl')
    || family.endsWith('-headless')
    || family.includes('stream-json')
    || family === 'claude-stream-json-bidi'
  ) {
    return DEFAULT_KNOWN_HARNESS_IDLE_TIMEOUT_MS;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

const PROVIDER_TERMINAL_FAILURE_REASONS = new Set([
  'api_error',
  'error',
  'failed',
  'aborted',
  'abort',
  'cancelled',
  'canceled',
  'interrupted',
  'timeout',
]);

/**
 * Classify explicit terminal frames for one-shot/ACP harnesses. App-server
 * Codex and Claude bidi have richer state machines in this file and are kept
 * out of this generic classifier. Harnesses without a reliable terminal
 * frame (plain-text tools) deliberately return null and retain their legacy
 * exit-code contract; they cannot be made strict without inventing protocol
 * semantics.
 */
export function classifyProviderTerminalFrame(runtimeFamily, parsed, { acp = false } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const family = typeof runtimeFamily === 'string' ? runtimeFamily.trim() : '';
  if (family === 'codex-json') {
    if (parsed.type === 'turn.completed') {
      const status = String(parsed.status || parsed.turn?.status || '').trim().toLowerCase();
      return ['failed', 'error', 'interrupted', 'cancelled', 'canceled'].includes(status)
        ? { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, `Codex turn ${status}`) }
        : { kind: 'completed', reason: 'turn.completed' };
    }
    if (parsed.type === 'turn.failed') {
      return { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, 'Codex turn failed') };
    }
    if (parsed.type === 'error') {
      return { kind: 'error', reason: readStructuredProviderFailureReason(parsed, 'Codex reported an error') };
    }
    return null;
  }
  if (family === 'copilot-json') {
    if (parsed.type === 'turn.completed') {
      const status = String(parsed.status || parsed.turn?.status || '').trim().toLowerCase();
      return ['failed', 'error', 'interrupted', 'cancelled', 'canceled'].includes(status)
        ? { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, `Copilot turn ${status}`) }
        : { kind: 'completed', reason: 'turn.completed' };
    }
    if (parsed.type === 'turn.failed') {
      return { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, 'Copilot turn failed') };
    }
    if (parsed.type === 'error') {
      return { kind: 'error', reason: readStructuredProviderFailureReason(parsed, 'Copilot reported an error') };
    }
    return null;
  }
  if (family === 'claude-stream-json') {
    if (parsed.type !== 'result') return null;
    const hasResultField = Object.prototype.hasOwnProperty.call(parsed, 'result');
    const terminalReason = typeof parsed.terminal_reason === 'string'
      ? parsed.terminal_reason.trim().toLowerCase()
      : '';
    const resultText = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    const invalidBody = parsed.subtype === 'success'
      && (!hasResultField || typeof parsed.result !== 'string');
    const failed = parsed.is_error === true
      || parsed.subtype === 'error'
      || Boolean(parsed.error)
      || invalidBody
      || PROVIDER_TERMINAL_FAILURE_REASONS.has(terminalReason)
      || /^api\s+error\b/i.test(resultText);
    return failed
      ? { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, 'Claude reported an error') }
      : { kind: 'completed', reason: 'result' };
  }
  if (family === 'agy-json' || family === 'agy-stream-json') {
    if (parsed.event !== 'result') return null;
    const result = parsed.result && typeof parsed.result === 'object' ? parsed.result : {};
    const success = String(result.status || '').trim().toUpperCase() === 'SUCCESS';
    return success
      ? { kind: 'completed', reason: 'result:SUCCESS' }
      : { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, 'Antigravity returned an unsuccessful result') };
  }
  if (family === 'pi-rpc-jsonl') {
    if (parsed.type === 'agent_end') return readPiTerminalOutcome(parsed);
    if (parsed.type === 'response' && parsed.success === false) {
      return { kind: 'error', reason: readStructuredProviderFailureReason(parsed, 'Pi RPC request failed') };
    }
    return null;
  }
  if (family === 'cline-json') {
    const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : '';
    if (type === 'done' || type === 'completed') return { kind: 'completed', reason: type };
    if (type === 'error') return { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, 'Cline run failed') };
    return null;
  }
  // ACP prompt responses are the only portable completion edge for the ACP
  // family. DeepSeek uses the same runtime family for a plain headless mode;
  // only classify it when the invocation actually enabled ACP.
  const isAcpFamily = acp || family === 'qwen-code-acp' || family === 'kimi-code-acp' || family === 'hermes-acp';
  if (isAcpFamily && parsed.id === 'agentoc-prompt') {
    return parsed.error
      ? { kind: 'failed', reason: readStructuredProviderFailureReason(parsed, 'ACP prompt failed') }
      : parsed.result
        ? { kind: 'completed', reason: 'agentoc-prompt' }
        : null;
  }
  return null;
}

function isContainedPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function createRunInputError(message, code = 'FILE_ASSET_RUN_INPUT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function verifyRunInputAttachment(attachment, index, currentRunId = runId) {
  const relativePath = typeof attachment?.relativePath === 'string' ? attachment.relativePath.trim() : '';
  const expectedHash = typeof attachment?.sha256 === 'string' ? attachment.sha256.trim().toLowerCase() : '';
  const expectedSize = Number.isInteger(attachment?.sizeBytes) && attachment.sizeBytes >= 0
    ? attachment.sizeBytes
    : null;
  if (!relativePath || !expectedHash || !SHA256_PATTERN.test(expectedHash) || expectedSize === null) {
    throw createRunInputError(`Run input ${index} has an incomplete server descriptor`, 'FILE_ASSET_RUN_INPUT_DESCRIPTOR_INVALID');
  }
  for (const key of ['inputPath', 'savedPath', 'localizedPath', 'directUrl', 'url']) {
    if (typeof attachment?.[key] === 'string' && attachment[key].trim()) {
      throw createRunInputError(`Run input ${index} contains a direct source reference`, 'FILE_ASSET_RUN_INPUT_SOURCE_LEAK');
    }
  }
  if (!RUN_ID_PATTERN.test(String(currentRunId || ''))) {
    throw createRunInputError('Run id is invalid', 'FILE_ASSET_RUN_ID_INVALID');
  }

  const runRoot = resolve(runDir(currentRunId));
  const inputRoot = join(runRoot, 'inputs');
  const candidate = resolve(runRoot, relativePath);
  if (!isContainedPath(inputRoot, candidate)) {
    throw createRunInputError(`Run input ${index} escapes the current Run input directory`, 'FILE_ASSET_RUN_INPUT_PATH_ESCAPE');
  }
  const [runStats, inputRootStats] = await Promise.all([
    lstat(runRoot).catch(() => null),
    lstat(inputRoot).catch(() => null),
  ]);
  if (!runStats || !inputRootStats || runStats.isSymbolicLink() || inputRootStats.isSymbolicLink()) {
    throw createRunInputError(`Run input ${index} has an unsafe current Run root`, 'FILE_ASSET_RUN_INPUT_ROOT_INVALID');
  }
  const realInputRoot = await realpath(inputRoot).catch(() => '');
  const realCandidate = await realpath(candidate).catch(() => '');
  if (!realInputRoot || !realCandidate || !isContainedPath(realInputRoot, realCandidate)) {
    throw createRunInputError(`Run input ${index} resolves outside the current Run input directory`, 'FILE_ASSET_RUN_INPUT_PATH_ESCAPE');
  }

  const sourceFlags = constants.O_RDONLY
    | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
  let handle = null;
  try {
    handle = await open(candidate, sourceFlags);
    const initialStat = await handle.stat();
    if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.size !== expectedSize) {
      throw createRunInputError(`Run input ${index} does not match its size descriptor`, 'FILE_ASSET_RUN_INPUT_SIZE_MISMATCH');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let sizeBytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
      sizeBytes += result.bytesRead;
    }
    const finalStat = await handle.stat();
    const actualHash = hash.digest('hex');
    if (!finalStat.isFile() || finalStat.size !== sizeBytes || sizeBytes !== expectedSize) {
      throw createRunInputError(`Run input ${index} changed during validation`, 'FILE_ASSET_RUN_INPUT_SIZE_MISMATCH');
    }
    if (actualHash !== expectedHash) {
      throw createRunInputError(`Run input ${index} does not match its hash descriptor`, 'FILE_ASSET_RUN_INPUT_HASH_MISMATCH');
    }
    return { ...attachment, inputPath: candidate, sha256: actualHash, sizeBytes };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertExactFileAssetEffects(effects) {
  return Array.isArray(effects)
    && effects.length === FILE_ASSET_READ_EFFECTS.length
    && FILE_ASSET_READ_EFFECTS.every((effect, index) => effects[index] === effect);
}

function hasValidOperationManifestHash(operation) {
  if (!operation || typeof operation !== 'object') return false;
  const { operationManifestHash, ...unsignedOperation } = operation;
  return typeof operationManifestHash === 'string'
    && operationManifestHash === computeSemanticManifestHash(unsignedOperation);
}

export function verifyRunInputBinding(manifest, run, currentRunId = runId) {
  if (assertRunPublication(run, manifest) && run.id !== currentRunId) throw runPublicationError();
  assertMessageRunBinding(run, manifest);
  const images = Array.isArray(manifest?.options?.images) ? manifest.options.images : [];
  const staging = manifest?.attachmentStaging;
  if (images.length === 0) {
    if (staging && (staging.decision !== 'ALLOW' || (staging.operations || []).length > 0)) {
      throw createRunInputError('Run attachment staging is non-empty without staged inputs', 'FILE_ASSET_RUN_INPUT_BINDING_INVALID');
    }
    return;
  }
  if (!staging || staging.schemaVersion !== FILE_ASSET_INPUT_STAGING_SCHEMA_VERSION
    || staging.operation !== FILE_ASSET_READ_OPERATION
    || staging.decision !== 'ALLOW'
    || !assertExactFileAssetEffects(staging.effects)
    || !staging.scope || staging.scope.computed !== true) {
    throw createRunInputError('Run attachment staging binding is incomplete', 'FILE_ASSET_RUN_INPUT_BINDING_INVALID');
  }
  const sessionId = typeof run?.sessionId === 'string' ? run.sessionId.trim() : '';
  const manifestSessionId = typeof manifest?.sessionId === 'string' ? manifest.sessionId.trim() : '';
  const requestId = typeof manifest?.requestId === 'string' ? manifest.requestId.trim() : '';
  if (!sessionId || !manifestSessionId || sessionId !== manifestSessionId
    || staging.scope.sessionId !== sessionId
    || staging.scope.runId !== currentRunId
    || !requestId
    || staging.scope.turnId !== requestId
    || !Array.isArray(staging.operations)
    || staging.operations.length !== images.length) {
    throw createRunInputError('Run attachment staging scope does not match the current Run', 'FILE_ASSET_RUN_INPUT_SCOPE_MISMATCH');
  }
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const operation = staging.operations[index];
    const assetId = typeof image?.assetId === 'string' ? image.assetId.trim() : '';
    const imageHash = typeof image?.sha256 === 'string' ? image.sha256.trim().toLowerCase() : '';
    const imageSize = Number.isInteger(image?.sizeBytes) ? image.sizeBytes : null;
    const binding = operation?.requestBinding;
    const snapshot = operation?.target?.resourceSnapshot;
    if (!assetId || !FILE_ASSET_ID_PATTERN.test(assetId)
      || !binding || binding.sessionId !== sessionId || binding.runId !== currentRunId
      || binding.turnId !== requestId || binding.requestKey !== assetId
      || operation.primaryAction !== FILE_ASSET_READ_OPERATION
      || operation.decision !== 'ALLOW'
      || !assertExactFileAssetEffects(operation.effects)
      || operation.executionClass !== 'session'
      || operation.target?.kind !== 'file_asset'
      || operation.target?.assetId !== assetId
      || operation.target?.resourceSnapshot?.identity !== `file_asset:${assetId}`
      || snapshot?.assetId !== assetId
      || snapshot?.sessionId !== sessionId
      || snapshot?.sha256 !== imageHash
      || snapshot?.sizeBytes !== imageSize
      || operation.scope?.kind !== 'current_run_inputs'
      || operation.scope?.computed !== true
      || operation.scope?.sessionId !== sessionId
      || operation.scope?.runId !== currentRunId
      || operation.scope?.turnId !== requestId
      || operation.scope?.relativePath !== image.relativePath
      || Object.prototype.hasOwnProperty.call(operation.scope || {}, 'root')
      || !hasValidOperationManifestHash(operation)
      || !validateSemanticOperation(operation).ok) {
      throw createRunInputError(`Run attachment operation ${index} is not bound to this Run`, 'FILE_ASSET_RUN_INPUT_OPERATION_MISMATCH');
    }
  }
}

export async function verifyRunInputAttachments(manifest, run, currentRunId = runId) {
  verifyRunInputBinding(manifest, run, currentRunId);
  const images = Array.isArray(manifest?.options?.images) ? manifest.options.images : [];
  if (images.length > 0) {
    const expectedInputRoot = await realpath(join(resolve(runDir(currentRunId)), 'inputs')).catch(() => '');
    if (!expectedInputRoot || Object.prototype.hasOwnProperty.call(manifest.attachmentStaging.scope, 'inputRoot')) {
      throw createRunInputError('Run attachment staging root does not match the current Run', 'FILE_ASSET_RUN_INPUT_ROOT_MISMATCH');
    }
  }
  // Hashing every attachment touches the same Run input volume and can hold
  // multiple large file descriptors/buffers at once. Preserve descriptor
  // order while keeping peak I/O bounded for multi-attachment Runs.
  return mapWithRunInputVerifyConcurrency(
    images,
    (attachment, index) => verifyRunInputAttachment(attachment, index, currentRunId),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateAfterProviderTerminal(runId, terminateManagedProcess, managedProcess = null) {
  await sleep(1000);
  if (managedProcess && managedProcess.exitCode !== null) return;
  const current = await getRun(runId).catch(() => null);
  if (current?.providerNativeDelegation?.delegationSummary?.active > 0) {
    // Provider-native children are parent-process-bound. Keep the provider
    // alive long enough to emit their terminal evidence; the idle watchdog
    // remains the upper bound and fails closed as delegation_lost.
    setTimeout(() => {
      void terminateAfterProviderTerminal(runId, terminateManagedProcess, managedProcess);
    }, 1000);
    return;
  }
  if (typeof terminateManagedProcess === 'function') {
    // Mark only cleanup initiated after a structured provider terminal frame.
    // Windows Job termination reports an exit code rather than SIGTERM.
    if (managedProcess) managedProcess.__agentocTerminalCleanupRequested = true;
    try { await terminateManagedProcess(); } catch {}
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeErrorMessage(error, fallback = 'Unknown sidecar error') {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  if (error === null || error === undefined) return fallback;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : fallback;
  } catch {
    return fallback;
  }
}

// Provider-specific wording is useful to humans but too unstable for the
// session loader and recovery dashboards. Normalize the recurrent early-exit
// classes once in the common sidecar so Codex, Claude, ACP, and service
// harnesses expose the same durable error contract.
export function classifyHarnessFailure(error) {
  const message = normalizeErrorMessage(error, '').toLowerCase();
  if (!message) return '';
  if (message.includes('readline was closed') || message.includes('closed stdin')) return 'HARNESS_STREAM_CLOSED';
  if (
    message.includes('before an accepted terminal')
    || message.includes('without an accepted terminal')
    || message.includes('closed before terminal event')
  ) return 'HARNESS_TERMINAL_MISSING';
  if (message.includes('mcp readiness') || message.includes('mcp_readiness_timeout')) return 'MCP_READINESS_TIMEOUT';
  if (message.includes('fresh-thread recovery') || message.includes('recovery sidecar')) return 'CODEX_RECOVERY_TIMEOUT';
  if (message.includes('startup timed out') || message.includes('app-server exited')) return 'HARNESS_STARTUP_FAILED';
  return '';
}

const MCP_OVERLAY_LEGACY_ERROR_CODE = 'MCP_OVERLAY_UNAVAILABLE';
const MCP_OVERLAY_STAGE_VALUES = new Set(['preflight', 'prepare', 'verify']);

function normalizeMcpOverlayPreparation(error, fallbackStage = 'prepare') {
  const errorCode = Object.values(MCP_OVERLAY_ERROR_CODES).includes(error?.code)
    ? error.code
    : MCP_OVERLAY_ERROR_CODES.PREPARE_FAILED;
  const stage = MCP_OVERLAY_STAGE_VALUES.has(error?.stage) ? error.stage : fallbackStage;
  const attempt = Number.isSafeInteger(error?.attempt) && error.attempt > 0
    ? error.attempt : 1;
  const maxAttempts = Number.isSafeInteger(error?.maxAttempts) && error.maxAttempts > 0
    ? error.maxAttempts : MCP_OVERLAY_MAX_ATTEMPTS;
  const safeCode = (value) => /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(String(value || '').trim())
    ? String(value).trim()
    : '';
  return {
    state: 'failed',
    stage,
    attempt,
    maxAttempts,
    errorCode,
    ...(safeCode(error?.causeCode) ? { causeCode: safeCode(error.causeCode) } : {}),
    ...(safeCode(error?.resource) ? { resource: safeCode(error.resource) } : {}),
    retryable: error?.retryable === true,
    legacyCode: MCP_OVERLAY_LEGACY_ERROR_CODE,
    finishedAt: nowIso(),
  };
}

function readyMcpOverlayPreparation(overlay) {
  const preparation = overlay?.preparation || {};
  return {
    state: 'ready',
    stage: MCP_OVERLAY_STAGE_VALUES.has(preparation.stage) ? preparation.stage : 'verify',
    attempt: Number.isSafeInteger(preparation.attempt) && preparation.attempt > 0
      ? preparation.attempt : 1,
    maxAttempts: Number.isSafeInteger(preparation.maxAttempts) && preparation.maxAttempts > 0
      ? preparation.maxAttempts : MCP_OVERLAY_MAX_ATTEMPTS,
    verified: true,
    finishedAt: nowIso(),
  };
}

async function requestLocalRunAuthRecovery({
  manifest,
  failureClass,
  failureAttempt,
  sideEffectsConfirmed,
} = {}) {
  const channel = manifest?.options?.runAuthRecoveryChannel;
  const token = typeof channel?.token === 'string' && channel.token.trim()
    ? channel.token.trim()
    : await readRunAuthRecoveryToken(runId);
  if (!token || !channel?.runId || !channel?.sessionId || !channel?.turnId) {
    return { ok: false, retry: false, reason: 'recovery-capability-unavailable' };
  }
  const baseUrl = String(process.env.AGENTOC_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}`).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  timeout.unref?.();
  try {
    const response = await fetch(`${baseUrl}/api/internal/run-auth-recovery`, {
      method: 'POST',
      headers: {
        ["x-agentoc-run-auth-recovery-token"]: token,
        ["x-agentoc-run-auth-recovery-run-id"]: channel.runId,
        ["x-agentoc-run-auth-recovery-session-id"]: channel.sessionId,
        ["x-agentoc-run-auth-recovery-turn-id"]: channel.turnId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        failureClass,
        failureAttempt,
        sideEffectsConfirmed: sideEffectsConfirmed === true,
        requesterProcessId: process.pid,
      }),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      return { ok: false, retry: false, reason: 'recovery-request-rejected', code: payload?.code || '' };
    }
    return {
      ok: payload?.ok === true,
      retry: payload?.retry === true,
      status: typeof payload?.status === 'string' ? payload.status : '',
      reason: typeof payload?.reason === 'string' ? payload.reason : '',
    };
  } catch {
    return { ok: false, retry: false, reason: 'recovery-request-unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function clipDiagnosticMessage(text, maxChars = 800) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function normalizeRunAuthAttempt(run) {
  const attempt = Number(run?.authRecovery?.resumeAttempt);
  return Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
}

export function classifyTerminalRunAuthFailure({
  cancelled = false,
  effectiveExitCode = 1,
  providerFailureReason = '',
  providerErrorPreview = '',
} = {}) {
  if (cancelled || Number(effectiveExitCode) === 0) return '';
  return classifyRunAuthFailure({ preview: providerFailureReason || providerErrorPreview });
}

// Provider streams repeat thread/session metadata on many frames. Avoid
// rewriting status.json for an identical patch: every rewrite wakes the
// control-plane watcher and can feed the observer back into another sync.
async function updateRunFieldsIfChanged(runId, fields = {}) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  return updateRun(runId, (current) => {
    if (entries.every(([key, value]) => Object.is(current?.[key], value))) {
      return current;
    }
    return { ...current, ...Object.fromEntries(entries) };
  });
}

function redactSecretFragments(text) {
  return String(text || '')
    .replace(/\bsk-[A-Za-z0-9_.*-]{12,}\b/g, (value) => (
      value.includes('*') ? value : `${value.slice(0, 8)}...redacted`
    ));
}

function collectProviderErrorParts(value, parts = []) {
  if (!value) return parts;
  if (typeof value === 'string') {
    if (value.trim()) parts.push(value.trim());
    return parts;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return parts;

  for (const key of ['message', 'additionalDetails', 'details', 'code']) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim()) {
      parts.push(entry.trim());
    } else if (entry && typeof entry === 'object') {
      collectProviderErrorParts(entry, parts);
    }
  }
  return parts;
}

function readStructuredProviderFailureReason(parsed, fallback = 'Provider reported an error') {
  const source = parsed?.error
    || parsed?.params?.error
    || parsed?.params?.turn?.error
    || parsed?.params
    || parsed;
  const seen = new Set();
  const parts = collectProviderErrorParts(source)
    .map((part) => redactSecretFragments(part))
    .map((part) => clipDiagnosticMessage(part, 500))
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return clipDiagnosticMessage(parts.join(' | '), 800) || fallback;
}

function describeStructuredRuntimeExit(runtimeFamily, preview = '') {
  const detail = clipDiagnosticMessage(preview, 800);
  if (detail && /(请登录|登录超时|auth|authentication|sso|sign in|login)/i.test(detail)) {
    return `Provider requires interactive login before Ragent can use it: ${detail}`;
  }
  if (detail) return `Provider exited without emitting structured events: ${detail}`;
  return `${runtimeFamily || 'Provider'} exited before an accepted terminal event`;
}

function payloadContainsText(value, pattern, depth = 0, seen = new Set()) {
  if (!value || depth > 8) return false;
  if (typeof value === 'string') return pattern.test(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => payloadContainsText(entry, pattern, depth + 1, seen));
  }
  return Object.values(value).some((entry) => payloadContainsText(entry, pattern, depth + 1, seen));
}

function isClaudeResumeNotFoundPayload(parsed) {
  return payloadContainsText(parsed, /No conversation found with session ID/i);
}

function safeDiagnosticDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return null;
  }
}

async function logSidecarDiagnostic(runId, message, details = null) {
  const payload = safeDiagnosticDetails(details);
  const printable = payload ? ` ${JSON.stringify(payload)}` : '';
  console.error(`[sidecar] ${message}${printable}`);
  if (!runId) return;
  try {
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'error',
      line: payload ? `${message} ${JSON.stringify(payload)}` : message,
      json: payload
        ? { type: 'sidecar.diagnostic', message, details: payload }
        : { type: 'sidecar.diagnostic', message },
    });
  } catch (error) {
    console.error(`[sidecar] Failed to append diagnostic for run ${runId}: ${normalizeErrorMessage(error)}`);
  }
}

async function persistRunTerminalState(runId, result, nextState, options = {}) {
  const failureMessage = result?.error || options.failureReason || '';
  const failureCode = result?.errorCode || classifyHarnessFailure(failureMessage);
  if (failureCode && !result?.errorCode) {
    result = { ...result, errorCode: failureCode };
  }
  const terminalCandidate = {
    outcome: nextState === 'cancelled'
      ? 'cancelled'
      : nextState === 'completed'
        ? 'completed'
        : 'failed',
    ...(options.failureReason ? { reason: options.failureReason } : {}),
  };
  try {
    // High-frequency stdout/stderr records are short-batched for throughput;
    // terminal state must never become visible before those records are on
    // disk, otherwise restart reconciliation can miss the final evidence.
    await flushRunSpool(runId);
  } catch (error) {
    console.error(`[sidecar] Failed to flush run spool before terminalization for ${runId}: ${normalizeErrorMessage(error)}`);
  }
  // A live delegation reconcile may have been coalesced behind a debounce
  // timer. Finish it after the spool flush so the pass sees the final raw
  // frames, then let the provider-exited replay below make the terminal
  // decision.
  await flushProviderNativeDelegationReconcile(runId);
  try {
    // The provider process has exited at this point.  If the spool contains
    // native child evidence, this path must go through the Join Barrier before
    // result.json/status.json can claim success.  Unresolved children become
    // lost and fail closed; runs without native evidence retain the legacy
    // terminal path below.
    const delegated = await reconcileProviderNativeDelegationRun({
      runId,
      result,
      terminalCandidate,
      providerExited: true,
      providerExitedAtMs: Date.now(),
      getRun,
      readRunSpoolRecords,
      streamRunSpoolRecords,
      appendRunSpoolRecord,
      updateRun,
      writeRunResult,
      protectedResultHandoff: isLinuxPeerResultRunner(),
    });
    if (delegated.handled) return delegated.run;
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Provider-native delegation reconciliation failed closed', {
      error: normalizeErrorMessage(error),
      nextState,
    });
    if (isLinuxPeerResultRunner()) return;
    // A failure while reconciling a purported provider-native terminal must
    // never fall through as a successful parent Run.  Non-terminal callers
    // already use the ordinary failure state; only completed is rewritten.
    if (nextState === 'completed') {
      nextState = 'failed';
      result = {
        ...(result || {}),
        exitCode: 1,
        error: 'delegation_reconciliation_failed',
      };
      options = { ...options, failureReason: 'delegation_reconciliation_failed' };
    }
  }
  try {
    await writeRunResult(runId, result);
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to persist detached runner result', {
      error: normalizeErrorMessage(error),
      nextState,
      resultCompletedAt: result?.completedAt || null,
    });
    if (isLinuxPeerResultRunner()) return;
  }

  // The control process commits terminal state only after reading the
  // authenticated, revoked peer result. Do not publish it from the runner.
  if (isLinuxPeerResultRunner()) return;

  try {
    const current = await getRun(runId);
    const approvedActionPause = nextState !== 'cancelled' && hasPendingApprovedAction(current);
    await updateRun(runId, (current) => ({
      ...current,
      // The provider can finish immediately after the MCP proposal is
      // persisted. Keep the run non-terminal until the owner resolves the
      // durable action batch; the session manager will settle it afterwards.
      state: approvedActionPause ? 'waiting_user' : nextState,
      completedAt: result?.completedAt || nowIso(),
      result,
      ...(Object.prototype.hasOwnProperty.call(options, 'failureReason')
        ? { failureReason: options.failureReason }
        : {}),
      ...(options.authRecovery ? { authRecovery: options.authRecovery } : {}),
      ...(options.cancellationCleanupStatus ? { cancellationCleanupStatus: options.cancellationCleanupStatus } : {}),
    }));
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to persist detached runner status', {
      error: normalizeErrorMessage(error),
      nextState,
      resultCompletedAt: result?.completedAt || null,
    });
  }
}

async function persistRunFailure(runId, error, options = {}) {
  const cancelled = options.cancelled === true;
  const message = normalizeErrorMessage(error);
  const errorCode = classifyHarnessFailure(error);
  if (options.logMessage !== false) {
    await logSidecarDiagnostic(
      runId,
      options.logLabel || 'Detached runner failed before persisting a result',
      {
        error: message,
        ...(safeDiagnosticDetails(options.details) || {}),
      },
    );
  }

  const result = {
    completedAt: nowIso(),
    exitCode: Number.isInteger(options.exitCode) ? options.exitCode : 1,
    signal: typeof options.signal === 'string' && options.signal ? options.signal : null,
    cancelled,
    ...(cancelled ? {} : { error: message }),
    ...(errorCode ? { errorCode } : {}),
  };

  await persistRunTerminalState(runId, result, cancelled ? 'cancelled' : 'failed', {
    ...(cancelled ? {} : { failureReason: message }),
  });
  return result;
}

export function stripRunnerControlEnv(source = {}) {
  const env = { ...source };
  delete env.AGENTOC_CONFIG_DIR;
  delete env.AGENTOC_INSTANCE_ROOT;
  delete env.AGENTOC_MEMORY_DIR;
  // The handoff token is for this sidecar only; never expose it to Codex,
  // Claude, MCP servers, or arbitrary provider subprocesses.
  delete env.AGENTOC_NATIVE_OAUTH_LOCK_PATH;
  delete env.AGENTOC_NATIVE_OAUTH_LOCK_TOKEN;
  for (const key of Object.keys(env)) {
    if (/^AGENTOC_(?:ASSET|FILE_ASSET)_/i.test(key)) delete env[key];
  }
  return env;
}

async function cleanEnv(toolId, manifest = {}, options = {}) {
  const env = stripRunnerControlEnv(buildToolProcessEnv(options.envOverrides || {}));
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.AGENTOC_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
  env.AGENTOC_PROJECT_ROOT = process.env.AGENTOC_PROJECT_ROOT || PROJECT_ROOT;
  env.RAGENT_CHAT_BASE_URL = env.AGENTOC_CHAT_BASE_URL;
  env.RAGENT_PROJECT_ROOT = env.AGENTOC_PROJECT_ROOT;
  delete env.RAGENT_SESSION_ID;
  if (typeof manifest?.sessionId === 'string' && manifest.sessionId.trim()) {
    env.AGENTOC_SESSION_ID = manifest.sessionId.trim();
    env.RAGENT_SESSION_ID = env.AGENTOC_SESSION_ID;
  }
  if (runId) {
    env.AGENTOC_RUN_ID = runId;
  }
  const collaborationCapabilities = Array.isArray(manifest?.options?.collaborationCapabilities)
    ? manifest.options.collaborationCapabilities
      .filter((entry) => entry && typeof entry === 'object' && entry.operation && entry.grantId && entry.token)
      .map((entry) => ({ operation: entry.operation, grantId: entry.grantId, token: entry.token }))
    : [];
  if (collaborationCapabilities.length > 0) {
    env.AGENTOC_COLLABORATION_CAPABILITIES = Buffer.from(
      JSON.stringify(collaborationCapabilities),
      'utf8',
    ).toString('base64url');
  } else {
    delete env.AGENTOC_COLLABORATION_CAPABILITIES;
  }
  // A normal owner Run cannot use the owner CLI socket from the detached
  // runner (the socket is deliberately 0600). Carry only the run-scoped
  // session-control capability instead; the control plane re-binds every
  // request to this Run and its delegated-session tree.
  delete env.AGENTOC_SESSION_CONTROL_TOKEN;
  delete env.AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN;
  delete env.AGENTOC_SESSION_CONTROL_RUN_ID;
  delete env.AGENTOC_SESSION_CONTROL_SESSION_ID;
  delete env.AGENTOC_SESSION_CONTROL_TURN_ID;
  const sessionControlChannel = manifest?.options?.sessionControlChannel;
  const sessionControlToken = sessionControlChannel?.token
    || await readRunSessionControlToken(runId);
  const sessionControlRenewalToken = sessionControlChannel?.renewalToken
    || await readRunSessionControlRenewalToken(runId);
  if (sessionControlToken && sessionControlChannel?.runId && sessionControlChannel?.sessionId) {
    env.AGENTOC_SESSION_CONTROL_TOKEN = sessionControlToken;
    env.AGENTOC_SESSION_CONTROL_RUN_ID = sessionControlChannel.runId;
    env.AGENTOC_SESSION_CONTROL_SESSION_ID = sessionControlChannel.sessionId;
    env.AGENTOC_SESSION_CONTROL_TURN_ID = sessionControlChannel.turnId || manifest.requestId || '';
    if (sessionControlRenewalToken) {
      env.AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN = sessionControlRenewalToken;
    }
    env.AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN_FILE = runSessionControlRenewalCapabilityPath(runId);
  }
  delete env.AGENTOC_BROWSER_MCP_ENABLED;
  delete env.AGENTOC_BROWSER_TOKEN;
  delete env.AGENTOC_BROWSER_CONFIRMATION_ENDPOINT;
  delete env.AGENTOC_BROWSER_SESSION_ID;
  delete env.AGENTOC_BROWSER_RUN_ID;
  delete env.AGENTOC_BROWSER_TURN_ID;
  delete env.AGENTOC_BROWSER_PROFILE_DIR;
  delete env.AGENTOC_BROWSER_ARTIFACT_DIR;
  const browserChannel = manifest?.options?.browserChannel;
  const browserChannelValid = validateBrowserCapabilityChannel(browserChannel, {
    runId,
    sessionId: manifest?.sessionId,
  }).valid && !isBrowserCapabilityExpired(browserChannel);
  const browserToken = browserChannelValid && browserChannel?.tokenHash && runId
    ? await readRunBrowserToken(runId)
    : '';
  if (browserToken
      && supportsBrowserMcpRuntime(options.runtimeFamily, { acp: options.acp === true })
      && browserChannel?.runId === runId
      && browserChannel?.sessionId === manifest?.sessionId) {
    const baseUrl = String(process.env.AGENTOC_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}`).replace(/\/+$/, '');
    env.AGENTOC_BROWSER_MCP_ENABLED = '1';
    env.AGENTOC_BROWSER_TOKEN = browserToken;
    env.AGENTOC_BROWSER_CONFIRMATION_ENDPOINT = `${baseUrl}${browserChannel.endpoint || '/api/internal/browser/confirmations'}`;
    env.AGENTOC_BROWSER_SESSION_ID = String(browserChannel.sessionId || '');
    env.AGENTOC_BROWSER_RUN_ID = String(browserChannel.runId || '');
    env.AGENTOC_BROWSER_TURN_ID = String(browserChannel.turnId || manifest.requestId || '');
    env.AGENTOC_BROWSER_PROFILE_DIR = sessionBrowserProfileDir(manifest?.sessionId || runId);
    env.AGENTOC_BROWSER_ARTIFACT_DIR = join(runDir(runId), 'browser', 'artifacts');
  }
  // A Run must not inherit the control user's or the launcher shell's Codex
  // home.  buildToolProcessEnv intentionally restores user-shell variables for
  // ordinary tools, so the managed runtime boundary has to bind CODEX_HOME at
  // the final sidecar boundary.  The lifecycle/supervisor launch modes and the
  // provider-homes path are broker-controlled values; personal Codex mode is
  // valid for owner-side tools, but never for an isolated Run.
  const runnerCodexHomeDir = typeof options.codexHomeDir === 'string' && options.codexHomeDir.trim()
    ? options.codexHomeDir.trim()
    : resolveRunnerCodexHomeDir();
  const runnerAgyHomeDir = typeof options.agyHomeDir === 'string' && options.agyHomeDir.trim()
    ? options.agyHomeDir.trim()
    : resolveRunnerAgyHomeDir();
  // Native Claude preparation writes the selected account's settings and
  // credential material under the broker-provided home. Bind that directory
  // here so the child cannot fall back to the interactive ~/.claude home.
  const runnerClaudeHomeDir = process.env.AGENTOC_PROVIDER_HOMES_DIR
    ? join(process.env.AGENTOC_PROVIDER_HOMES_DIR, 'claude')
    : '';
  const genericHarnessDir = {
    'pi-rpc-jsonl': 'pi', 'qwen-code-acp': 'qwen-code',
    'opencode-json': 'opencode', 'kimi-code-acp': 'kimi-code',
    'goose-headless': 'goose', 'openhands-headless': 'openhands',
    'copilot-json': 'copilot', 'hermes-acp': 'hermes',
    'cline-json': 'cline', 'kilo-json': 'kilo',
  }[typeof options.runtimeFamily === 'string' ? options.runtimeFamily.trim() : ''];
  const harnessHomeDir = genericHarnessDir && process.env.AGENTOC_PROVIDER_HOMES_DIR
    ? join(process.env.AGENTOC_PROVIDER_HOMES_DIR, genericHarnessDir)
    : '';
  return applyManagedRuntimeEnv(toolId, env, {
    runtimeFamily: typeof options.runtimeFamily === 'string' ? options.runtimeFamily : '',
    acp: options.acp === true,
    ...(runnerCodexHomeDir
      ? { codexHomeMode: 'managed', codexHomeDir: runnerCodexHomeDir }
      : {}),
    ...(runnerAgyHomeDir ? { agyHomeDir: runnerAgyHomeDir } : {}),
    ...(runnerClaudeHomeDir
      ? { claudeHomeDir: runnerClaudeHomeDir, claudeHomeBridgeDir: runnerClaudeHomeDir }
      : {}),
    ...(harnessHomeDir ? { harnessHomeDir } : {}),
  });
}

function readAgyConversationId(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const direct = [
    parsed.conversation_id,
    parsed.conversationId,
    parsed.session_id,
    parsed.sessionId,
    parsed.conversation?.id,
    parsed.session?.id,
    parsed.init?.conversation_id,
    parsed.init?.conversationId,
    parsed.step_update?.conversation_id,
    parsed.step_update?.conversationId,
    parsed.data?.conversation_id,
    parsed.data?.conversationId,
    parsed.result?.conversation_id,
    parsed.result?.conversationId,
    parsed.result?.conversation?.id,
    parsed.providerSessionId,
  ];
  return direct.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function captureResume(run, parsed, { expectedCodexThreadId = '', runtimeFamily = '' } = {}) {
  if (!run || !parsed || typeof parsed !== 'object') return null;
  if (runtimeFamily === 'agy-json' || runtimeFamily === 'agy-stream-json') {
    const conversationId = readAgyConversationId(parsed);
    if (conversationId) {
      return {
        agyConversationId: conversationId,
        providerResumeId: conversationId,
      };
    }
  }
  if (runtimeFamily.endsWith('-acp')
      && (parsed.id === 'agentoc-session-new' || parsed.id === 'agentoc-session-load')
      && !parsed.error) {
    const sessionId = acpSessionIdFromResponse(parsed)
      || (parsed.id === 'agentoc-session-load' ? run?.providerResumeId : '');
    if (sessionId) {
      return {
        providerResumeId: sessionId,
        ...(runtimeFamily === 'hermes-acp' ? { hermesSessionId: sessionId } : {}),
      };
    }
  }
  // Cline uses `sessionId`/`session_id` in its agent-event envelope and Kilo
  // uses `sessionID`. Handle these before the legacy Claude `session_id`
  // branch so a Cline event can never bind a run to Claude's session store.
  if (runtimeFamily === 'cline-json') {
    const envelope = parsed.type === 'agent_event'
      && parsed.payload && typeof parsed.payload === 'object'
      ? parsed.payload
      : parsed;
    const event = envelope.event && typeof envelope.event === 'object'
      ? envelope.event
      : envelope;
    const sessionId = [
      event.sessionId,
      event.session_id,
      envelope.sessionId,
      envelope.session_id,
      parsed.sessionId,
      parsed.session_id,
      run?.providerResumeId,
    ].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
    if (sessionId) return { providerResumeId: sessionId };
  }
  if (runtimeFamily === 'kilo-json') {
    const sessionId = [
      parsed.sessionID,
      parsed.sessionId,
      parsed.session_id,
      run?.providerResumeId,
    ].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
    if (sessionId) return { providerResumeId: sessionId };
  }
  if (parsed.session_id) {
    return {
      claudeSessionId: parsed.session_id,
      providerResumeId: parsed.session_id,
    };
  }
  if (parsed.type === 'thread.started' && parsed.thread_id) {
    if (expectedCodexThreadId && parsed.thread_id !== expectedCodexThreadId) return null;
    if (runtimeFamily === 'copilot-json') {
      return {
        providerResumeId: parsed.thread_id,
      };
    }
    return {
      codexThreadId: parsed.thread_id,
      providerResumeId: parsed.thread_id,
    };
  }
  const appServerThreadId = readCodexAppServerThreadId(parsed);
  if (appServerThreadId) {
    if (expectedCodexThreadId && appServerThreadId !== expectedCodexThreadId) return null;
    return {
      codexThreadId: appServerThreadId,
      providerResumeId: appServerThreadId,
      appServerThreadId,
    };
  }
  return null;
}

export function resolveCodexRunModelSelection(options = {}, resolvedModel = '') {
  const { model, providerId: modelProviderId } = parseScopedCodexModel(resolvedModel);
  const providerId = typeof options.providerProfile === 'string' && options.providerProfile.trim()
    ? options.providerProfile.trim()
    : modelProviderId;
  return { model, providerId };
}

export async function createCodexAppServerRunState({
  prompt,
  freshRecoveryPrompt,
  manifest,
  cwd,
  codexHomeDir,
  forceFreshRecovery = false,
}) {
  manifest = applyWorkbenchRunPolicy(manifest);
  const options = manifest?.options || {};
  const riskContextBinding = resolveRunRiskContext(manifest);
  const normalDeveloperInstructions = typeof manifest?.developerInstructions === 'string'
    ? manifest.developerInstructions
    : '';
  const recoveryDeveloperInstructions = typeof manifest?.freshRecoveryDeveloperInstructions === 'string'
    ? manifest.freshRecoveryDeveloperInstructions
    : normalDeveloperInstructions;
  const initialPrompt = forceFreshRecovery
    ? (typeof freshRecoveryPrompt === 'string' && freshRecoveryPrompt ? freshRecoveryPrompt : prompt)
    : prompt;
  // Preparation only reads local state. Query official-account models on the
  // actual authorized Run process after initialize, never a second upstream.
  const modelChoice = typeof options.model === 'string' && options.model.trim()
    ? { model: options.model, needsAccountCatalog: false }
    : await prepareImplicitCodexAppServerModel({
      codexHomeDir,
      readAuth: (path) => readJsonIfPresent(path, readFile),
      readPreferred: readPreferredCodexModelFromConfig,
    });
  // —— 2026-08-09 模型选择注入：`model@providerId` 拆出真实 model + 目标
  // provider。无后缀（历史会话/默认选择）→ providerId 空 = 沿用 current。
  // state.model 必须用真实 model id（turn start 消息直发上游，带后缀会 404）。
  const { model: realModel, providerId } = resolveCodexRunModelSelection(options, modelChoice.model);
  return {
    prompt: String(initialPrompt || ''),
    freshRecoveryPrompt: typeof freshRecoveryPrompt === 'string' && freshRecoveryPrompt
      ? freshRecoveryPrompt
      : String(prompt || ''),
    requestId: typeof manifest?.requestId === 'string' ? manifest.requestId : '',
    cwd,
    // The replacement sidecar must not reconstruct the resume target that
    // the parent has already proved unavailable.
    threadId: !forceFreshRecovery && typeof options.codexThreadId === 'string' ? options.codexThreadId : '',
    turnId: '',
    interactionMode: typeof options.interactionMode === 'string' ? options.interactionMode : '',
    permissionMode: typeof options.permissionMode === 'string' ? options.permissionMode : '',
    agentocApprovalGate: isCodexAppServerRagentApprovalGateEnabled({ riskMode: options.riskMode, permissionMode: options.permissionMode }),
    approvalPolicyVerified: false,
    privilegedMode: options.privilegedMode === true,
    riskMode: typeof options.riskMode === 'string' ? options.riskMode : '',
    riskContext: riskContextBinding.riskContext,
    riskContextValid: riskContextBinding.valid,
    riskContextInvalidReason: riskContextBinding.valid ? '' : riskContextBinding.reason,
    projectRoot: typeof options.projectRoot === 'string' ? options.projectRoot : '',
    model: realModel,
    needsAccountModelCatalog: modelChoice.needsAccountCatalog,
    accountModelCatalog: null,
    providerId,
    reasoningEffort: typeof options.effort === 'string' ? options.effort : '',
    developerInstructions: forceFreshRecovery ? recoveryDeveloperInstructions : normalDeveloperInstructions,
    freshRecoveryDeveloperInstructions: recoveryDeveloperInstructions,
    useResume: !forceFreshRecovery && options.codexResume === true,
    rolloutPath: '',
    rolloutResumeAttempted: false,
    threadRequestId: CODEX_APP_SERVER_REQUEST_IDS.thread,
    initializeRequestId: CODEX_APP_SERVER_REQUEST_IDS.initialize,
    initialized: false,
    threadRequestSent: false,
    startupCancelled: false,
    resumeRecoveryAttempted: false,
    codexGoal: options.codexGoal && typeof options.codexGoal === 'object' ? options.codexGoal : null,
    goalApplied: false,
    goalClearRequestId: null,
    goalSetRequestId: null,
    startedTurn: false,
    turnRetryCount: 0,
    // A retry must be scheduled outside the ordered stdout handler.  Keeping
    // the timer here lets lifecycle cleanup cancel it and prevents a late
    // retry from writing to a process that has already exited.
    turnRetryTimer: null,
    terminalSeen: false,
    providerStage: 'created',
    providerErrorCode: null,
    providerErrorMethod: '',
    startupTimer: null,
    freshRecoveryRequested: false,
    activeItems: new Map(),
    idleTerminationReason: '',
    idleTerminationGraceTimer: null,
    interruptSent: false,
    mcpRequired: false,
    mcpRequiredServers: [],
    mcpAutoApproveServerNames: new Set(),
    mcpExpectedServerName: '',
    mcpRequiredToolNames: [],
    mcpStartupStatuses: Object.create(null),
    mcpInventory: null,
    mcpStatusRequestId: null,
    mcpStatusRequestAfterReady: false,
    mcpDiscoveryStarted: false,
    mcpReadyStatusObserved: false,
    mcpReady: false,
    mcpReadinessTimer: null,
    mcpStartupFallbackTimer: null,
    mcpStartupFallbackReady: false,
    mcpFailureReason: '',
    hadError: false,
    failureReason: '',
    nextControlRequestId: 1000,
    sentSteerIds: new Set(),
    pendingApprovals: new Map(),
    sentApprovalResponseIds: new Set(),
    autoApprovedMcpRequestIds: new Set(),
    privilegedTurnOps: [],
  };
}

function writeCodexAppServerMessage(proc, message) {
  if (!proc?.stdin?.writable || !message) return false;
  try {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    return false;
  }
}

function markCodexAppServerFailure(state, parsed, fallback = 'Codex app-server reported an error') {
  if (!state) return '';
  const reason = readStructuredProviderFailureReason(parsed, fallback);
  const error = parsed?.error || parsed?.params?.error || null;
  const code = error && (typeof error.code === 'number' || typeof error.code === 'string')
    ? error.code
    : null;
  state.hadError = true;
  state.failureReason = reason;
  state.providerErrorCode = code;
  state.providerErrorMethod = typeof parsed?.method === 'string'
    ? parsed.method
    : (typeof parsed?.id !== 'undefined' ? `request:${String(parsed.id)}` : 'provider');
  state.providerStage = 'failed';
  return reason;
}

export function configureWindowsClaudeWorkingDirectory(env, { platform = process.platform, bidi = false, riskMode = '' } = {}) {
  if (platform === 'win32' && bidi && ['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(riskMode)) {
    env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1';
  }
}

function createClaudeBidiRunState({ prompt, manifest, cwd } = {}) {
  manifest = applyWorkbenchRunPolicy(manifest);
  const options = manifest?.options || {};
  const riskContextBinding = resolveRunRiskContext(manifest);
  return {
    prompt: typeof prompt === 'string' ? prompt : '',
    requestId: typeof manifest?.requestId === 'string' ? manifest.requestId : '',
    claudeSessionId: typeof options.claudeSessionId === 'string' ? options.claudeSessionId : '',
    cwd: typeof cwd === 'string' ? cwd : '',
    privilegedMode: options.privilegedMode === true,
    riskMode: typeof options.riskMode === 'string' ? options.riskMode : '',
    riskContext: riskContextBinding.riskContext,
    riskContextValid: riskContextBinding.valid,
    riskContextInvalidReason: riskContextBinding.valid ? '' : riskContextBinding.reason,
    permissionMode: typeof options.permissionMode === 'string' ? options.permissionMode : '',
    interactionMode: typeof options.interactionMode === 'string' ? options.interactionMode : '',
    projectRoot: typeof options.projectRoot === 'string' ? options.projectRoot : '',
    privilegedTurnOps: [],
    initialized: false,
    initializeRequestId: 'agentoc-initialize-1',
    nextControlRequestId: 2,
    startedTurn: false,
    turnActive: false,
    approvalTurnSequence: 0,
    approvalProcessId: randomUUID(),
    terminalSeen: false,
    interruptSent: false,
    pendingInterruptRequestId: '',
    pendingInterruptReason: '',
    steerAwaitingTurnEnd: false,
    hadError: false,
    failureReason: '',
    providerSessionId: '',
    sentSteerIds: new Set(),
    pendingApprovals: new Map(),
    sentApprovalResponseIds: new Set(),
    autoApprovedMcpRequestIds: new Set(),
    lastControlActivityAt: 0,
    mcpRequired: false,
    mcpRequiredServers: [],
    mcpAutoApproveServerNames: new Set(),
    mcpExpectedServerName: '',
    mcpRequiredToolNames: [],
  };
}

function writeClaudeBidiMessage(proc, message) {
  if (!proc?.stdin?.writable || !message) return false;
  try {
    proc.stdin.write(serializeClaudeBidiMessage(message));
    return true;
  } catch {
    // Provider shutdown and control polling can race. Treat a closed stdin as
    // an ordinary failed write so the lifecycle path can terminalize the Run
    // instead of leaking an uncaught EPIPE from a later steer/approval.
    return false;
  }
}

function nextClaudeBidiControlRequestId(state) {
  const requestId = `agentoc-control-${state.nextControlRequestId}`;
  state.nextControlRequestId += 1;
  return requestId;
}

function startClaudeBidiTurn(proc, state, text, sessionId = '') {
  const written = writeClaudeBidiMessage(proc, buildClaudeBidiUserMessage({ text, sessionId }));
  if (written) {
    state.startedTurn = true;
    state.turnActive = true;
    state.approvalTurnSequence = (state.approvalTurnSequence || 0) + 1;
  }
  return written;
}

function writeInitialClaudeBidiMessages(proc, state) {
  writeClaudeBidiMessage(proc, buildClaudeBidiInitializeMessage(state.initializeRequestId));
}

function handleClaudeBidiControlResponse(proc, state, parsed) {
  const control = readClaudeBidiControlResponse(parsed);
  if (!control) return false;
  if (control.requestId === state.initializeRequestId) {
    if (!control.success) {
      state.hadError = true;
      state.terminalSeen = true;
      return true;
    }
    state.initialized = true;
    if (!state.startedTurn) {
      startClaudeBidiTurn(proc, state, state.prompt, state.claudeSessionId || '');
    }
    return true;
  }
  if (control.requestId && control.requestId === state.pendingInterruptRequestId) {
    state.pendingInterruptRequestId = '';
    state.pendingInterruptReason = '';
    return true;
  }
  return false;
}

async function markClaudeBidiSteerSent(runId, steerId) {
  const sentIds = Array.isArray(steerId) ? steerId : [steerId];
  const normalizedIds = new Set(
    sentIds.map((value) => (typeof value === 'string' ? value : '')).filter(Boolean),
  );
  if (!runId || normalizedIds.size === 0) return;
  const sentAt = nowIso();
  await updateRun(runId, (current) => ({
    ...current,
    appServerSteerQueue: Array.isArray(current?.appServerSteerQueue)
      ? current.appServerSteerQueue.map((entry) => (
        normalizedIds.has(entry?.id)
          ? { ...entry, sentAt: entry.sentAt || sentAt, state: 'sent' }
          : entry
      ))
      : [],
  }));
}

async function flushClaudeBidiSteerQueue(proc, state, run) {
  if (!state || state.terminalSeen || !state.initialized || run?.cancelRequested) return;
  const queue = Array.isArray(run?.appServerSteerQueue) ? run.appServerSteerQueue : [];
  for (const entry of queue) {
    const steerId = typeof entry?.id === 'string' ? entry.id : '';
    if (!steerId || state.sentSteerIds.has(steerId) || entry?.state === 'sent') continue;
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (!text.trim()) continue;
    if (state.turnActive) {
      if (!state.pendingInterruptRequestId) {
        const requestId = nextClaudeBidiControlRequestId(state);
        if (writeClaudeBidiMessage(proc, buildClaudeBidiInterruptMessage(requestId))) {
          state.pendingInterruptRequestId = requestId;
          state.pendingInterruptReason = 'steer';
          state.steerAwaitingTurnEnd = true;
        }
      }
      return;
    }
    if (startClaudeBidiTurn(proc, state, text)) {
      state.sentSteerIds.add(steerId);
      await markClaudeBidiSteerSent(run.id, steerId);
    }
    return;
  }
}

function maybeInterruptClaudeBidiTurn(proc, state) {
  if (!state || state.interruptSent || state.terminalSeen || !state.initialized || !state.turnActive) return false;
  if (state.pendingInterruptRequestId) {
    state.interruptSent = true;
    state.pendingInterruptReason = 'cancel';
    return true;
  }
  const requestId = nextClaudeBidiControlRequestId(state);
  if (!writeClaudeBidiMessage(proc, buildClaudeBidiInterruptMessage(requestId))) return false;
  state.pendingInterruptRequestId = requestId;
  state.pendingInterruptReason = 'cancel';
  state.interruptSent = true;
  return true;
}

function writeInitialCodexAppServerMessages(proc, state) {
  if (state) state.providerStage = 'initialize_sent';
  writeCodexAppServerMessage(proc, buildCodexAppServerInitializeMessage());
}

export function writeCodexAppServerThreadStart(proc, state) {
  if (!state || state.threadRequestSent || state.terminalSeen || state.hadError
      || state.startupCancelled || state.needsAccountModelCatalog) return false;
  state.providerStage = state.useResume ? 'thread_resume_sent' : 'thread_start_sent';
  const written = writeCodexAppServerMessage(proc, buildCodexAppServerThreadMessage({
    id: state.threadRequestId,
    threadId: state.threadId,
    useResume: state.useResume,
    rolloutPath: state.rolloutPath,
    cwd: state.cwd,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    developerInstructions: state.developerInstructions,
    interactionMode: state.interactionMode,
    permissionMode: state.permissionMode,
    agentocApprovalGate: state.agentocApprovalGate,
    threadMcpConfig: state.threadMcpConfig,
    threadShellEnvironment: state.threadShellEnvironment,
    executionEnvironment: state.executionEnvironment,
  }));
  if (written) state.threadRequestSent = true;
  return written;
}

export function configureCodexAccountModelCatalog({ proc, state, beforeReady, onFailure }) {
  if (!state?.needsAccountModelCatalog) return null;
  state.accountModelCatalog = createCodexAccountModelCatalog({
    nextRequestId: () => state.nextControlRequestId++,
    sendRequest: ({ id, cursor }) => writeCodexAppServerMessage(proc,
      buildCodexAppServerModelListMessage({ id, cursor, limit: 100, includeHidden: false })),
    beforeReady,
    onReady: (model) => {
      if (state.terminalSeen || state.hadError || state.startupCancelled) {
        throw Object.assign(new Error('Run stopped during model selection'), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      }
      state.model = model;
      state.needsAccountModelCatalog = false;
      if (!writeCodexAppServerThreadStart(proc, state)) {
        throw Object.assign(new Error('Codex app-server closed stdin'), { code: 'CODEX_STDIN_CLOSED' });
      }
    },
    onFailure,
  });
  return state.accountModelCatalog;
}

export function consumeCodexSharedHookRegistration(state, parsed) {
  const registration = state?.sharedHookRegistration;
  if (!registration || parsed?.id !== registration.id || parsed?.method) return false;
  state.sharedHookRegistration = null;
  if (parsed.error) {
    state.hadError = true;
    state.terminalSeen = true;
    state.failureReason = 'Shared Codex Windows hook could not be registered';
  } else registration.onReady();
  return true;
}

function continueCodexAppServerStartup(proc, state) {
  if (state.terminalSeen || state.hadError || state.startupCancelled) return;
  if (state.needsAccountModelCatalog) {
    state.providerStage = 'account_model_catalog';
    if (state.accountModelCatalog) state.accountModelCatalog.start();
    else {
      markCodexAppServerFailure(state, { error: { code: 'CODEX_ACCOUNT_MODEL_CATALOG_UNAVAILABLE',
        message: 'Run model negotiation was not configured' } });
      state.terminalSeen = true;
    }
  } else writeCodexAppServerThreadStart(proc, state);
}

export function configureCodexReadOnlyEnvironment({ proc, state, executor, environmentId, workspace, hidePaths,
  beforeReady = async () => {}, onFailure = () => {}, prepareMcp, readOnly = true, runnerHome = '' } = {}) {
  if (!state || !executor) return null;
  const fail = error => {
    if (state.terminalSeen || state.startupCancelled) return;
    state.hadError = true; state.terminalSeen = true;
    state.failureReason = error?.message || 'Codex read-only execution environment is unavailable';
    state.providerErrorCode = error?.code || 'CODEX_READONLY_ENVIRONMENT_UNAVAILABLE';
    onFailure(error);
  };
  const setup = createCodexReadOnlyEnvironmentSetup({ environmentId, cwd: state.cwd, workspace, hidePaths, executor, readOnly, runnerHome,
    additionalServers: state.threadMcpConfig?.mcp_servers || {},
    nextRequestId: () => state.nextControlRequestId++, send: message => writeCodexAppServerMessage(proc, message),
    ...(prepareMcp ? { prepareMcp } : {}),
    onReady: selected => {
      void (async () => {
        try {
          await beforeReady();
          if (state.terminalSeen || state.hadError || state.startupCancelled) { await setup.close(); return; }
          state.executionEnvironment = selected.executionEnvironment;
          state.threadMcpConfig = selected.threadMcpConfig;
          continueCodexAppServerStartup(proc, state);
        } catch { fail({ code: 'CODEX_READONLY_ENVIRONMENT_UNAVAILABLE', message: 'Codex read-only execution environment is unavailable' }); await setup.close(); }
      })();
    }, onFailure: fail });
  state.readOnlyEnvironmentSetup = setup;
  return setup;
}

export function handleCodexAppServerInitializeResponse(proc, state, parsed) {
  if (!state || state.initialized || state.terminalSeen || state.hadError
      || state.startupCancelled || parsed?.id !== state.initializeRequestId) return false;
  if (parsed?.error) {
    markCodexAppServerFailure(state, parsed, 'Codex app-server initialize failed');
    state.terminalSeen = true;
    return true;
  }
  state.initialized = true;
  state.providerStage = 'initialized';
  writeCodexAppServerMessage(proc, buildCodexAppServerInitializedNotification());
  const continueStartup = () => {
    if (state.terminalSeen || state.hadError || state.startupCancelled) return;
    if (state.readOnlyEnvironmentSetup) {
      state.providerStage = 'readonly_environment';
      state.readOnlyEnvironmentSetup.start();
    } else continueCodexAppServerStartup(proc, state);
  };
  if (state.codexWindowsInstallHook) {
    state.providerStage = 'managed_hook_setup';
    state.codexManagedHookSetup = createCodexManagedHookSetup({ ...state.codexWindowsInstallHook, cwd: state.cwd,
      nextRequestId: () => state.nextControlRequestId++, send: message => writeCodexAppServerMessage(proc, message),
      onDone: (ready, selected) => {
        state.codexManagedHookReady = ready;
        if (!state.codexWindowsInstallHook.shared) { continueStartup(); return; }
        if (!ready || !selected || !Number.isSafeInteger(selected.displayOrder)) {
          state.hadError = true; state.terminalSeen = true;
          state.failureReason = 'Shared Codex Windows hook trust could not be verified';
          return;
        }
        const id = state.nextControlRequestId++;
        state.sharedHookRegistration = { id, onReady: continueStartup };
        if (!writeCodexAppServerMessage(proc, { id, method: 'agentoc/registerWindowsHook', params: {
          sourcePath: selected.sourcePath, displayOrder: selected.displayOrder,
        } })) {
          state.sharedHookRegistration = null; state.hadError = true; state.terminalSeen = true;
          state.failureReason = 'Shared Codex Windows hook registration could not be sent';
        }
      } });
    state.codexManagedHookSetup.start();
  } else continueStartup();
  return true;
}

function requestCodexAppServerMcpStatusList(proc, state, { force = false } = {}) {
  if (!state?.mcpRequired || !state.threadId || (!force && state.mcpReady)) {
    return false;
  }
  if (state.mcpStatusRequestId !== null) {
    return false;
  }
  if (!force && state.mcpDiscoveryStarted) {
    return false;
  }
  const requestId = state.nextControlRequestId;
  state.nextControlRequestId += 1;
  const message = buildCodexAppServerMcpServerStatusListMessage({
    id: requestId,
    threadId: state.threadId,
    detail: 'full',
  });
  if (!message || !writeCodexAppServerMessage(proc, message)) return false;
  state.mcpStatusRequestId = requestId;
  state.mcpStatusRequestAfterReady = state.mcpReadyStatusObserved === true;
  state.mcpDiscoveryStarted = true;
  return true;
}

function getCodexAppServerMcpReadiness(state) {
  return evaluateCodexAppServerMcpReadiness({
    inventory: state?.mcpInventory,
    startupStatuses: state?.mcpStartupStatuses,
    expectedServerName: state?.mcpExpectedServerName,
    requiredToolNames: state?.mcpRequiredToolNames,
    requiredServers: state?.mcpRequiredServers,
  });
}

function areRequiredCodexMcpServersStartupReady(state) {
  const requiredNames = [...new Set(
    (state?.mcpRequiredServers || []).map((server) => server?.name).filter(Boolean),
  )];
  return requiredNames.length > 0
    && requiredNames.every((name) => state?.mcpStartupStatuses?.[name] === 'ready');
}

function clearCodexAppServerMcpStartupFallback(state) {
  if (!state?.mcpStartupFallbackTimer) return;
  clearTimeout(state.mcpStartupFallbackTimer);
  state.mcpStartupFallbackTimer = null;
}

function armCodexAppServerMcpStartupFallback(runId, state, proc) {
  if (
    !state?.mcpRequired
    || state.mcpStartupFallbackTimer
    || state.mcpReady
    || state.startedTurn
    || !areRequiredCodexMcpServersStartupReady(state)
  ) return;
  const configured = Number(process.env.AGENTOC_CODEX_MCP_STARTUP_FALLBACK_MS);
  const delayMs = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CODEX_MCP_STARTUP_FALLBACK_MS;
  state.mcpStartupFallbackTimer = setTimeout(() => {
    state.mcpStartupFallbackTimer = null;
    void (async () => {
      if (
        state.terminalSeen
        || state.startedTurn
        || state.mcpReady
        || !areRequiredCodexMcpServersStartupReady(state)
      ) return;
      // The overlay has already been prepared and every AgentoC-owned server
      // reported `ready`. Only the optional inventory response is absent.
      state.mcpStartupFallbackReady = true;
      state.mcpReady = true;
      if (state.mcpReadinessTimer) {
        clearTimeout(state.mcpReadinessTimer);
        state.mcpReadinessTimer = null;
      }
      await appendRunSpoolRecord(runId, {
        ts: nowIso(),
        stream: 'stdout',
        json: {
          type: 'status',
          role: 'system',
          content: 'MCP ready (managed startup verified; inventory response delayed)',
          provider: 'codex',
          runtimeFamily: 'codex-app-server-json',
          codexMcpStatus: 'ready',
          codexMcpReadiness: 'startup-verified',
          codexMcpServer: state.mcpExpectedServerName,
          codexMcpTools: state.mcpRequiredToolNames || [],
        },
      });
      if (state.threadId && !state.startedTurn) {
        maybeStartCodexAppServerTurn(proc, state, {
          method: 'thread/started',
          params: { thread: { id: state.threadId } },
        });
      }
    })().catch(() => {});
  }, delayMs);
  state.mcpStartupFallbackTimer.unref?.();
}

function armCodexAppServerMcpReadinessTimeout(runId, state, terminate) {
  if (!state?.mcpRequired || state.mcpReadinessTimer || state.mcpReady) return;
  const configured = Number(process.env.AGENTOC_CODEX_MCP_READINESS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  state.mcpReadinessTimer = setTimeout(() => {
    state.mcpReadinessTimer = null;
    if (state.mcpReady || state.terminalSeen) return;

    // MCP timing fix: If MCP is not ready and turn hasn't started yet,
    // fail the run to prevent execution without required MCP tools
    if (!state.startedTurn) {
      void failCodexAppServerMcpReadiness(
        runId,
        state,
        terminate,
        'MCP_READINESS_TIMEOUT',
      );
    }
  }, timeoutMs);
  if (typeof state.mcpReadinessTimer.unref === 'function') state.mcpReadinessTimer.unref();
}

async function failCodexAppServerMcpReadiness(runId, state, terminate, reasonCode) {
  if (!state || state.mcpFailureReason || state.terminalSeen) return false;
  state.mcpFailureReason = `MCP readiness failed: ${reasonCode}`;
  state.failureReason = state.mcpFailureReason;
  state.hadError = true;
  state.terminalSeen = true;
  if (state.mcpReadinessTimer) {
    clearTimeout(state.mcpReadinessTimer);
    state.mcpReadinessTimer = null;
  }
  clearCodexAppServerMcpStartupFallback(state);
  await appendRunSpoolRecord(runId, {
    ts: nowIso(),
    stream: 'error',
    json: {
      type: 'status',
      role: 'system',
      content: state.mcpFailureReason,
      provider: 'codex',
      runtimeFamily: 'codex-app-server-json',
      codexMcpStatus: 'failed',
      codexMcpReadiness: 'failed',
      codexMcpFailureReason: reasonCode,
    },
  });
  try {
    await terminate?.();
  } catch {}
  return true;
}

async function consumeCodexAppServerMcpStatusList(runId, state, proc, parsed, terminate) {
  if (!state?.mcpRequired || parsed?.id !== state.mcpStatusRequestId) return false;
  const requestWasAfterReady = state.mcpStatusRequestAfterReady === true;
  state.mcpStatusRequestId = null;
  state.mcpStatusRequestAfterReady = false;
  if (state.mcpReadyStatusObserved && !requestWasAfterReady) {
    // A ready notification may race the initial inventory response. That
    // response was requested before readiness and may contain an empty or
    // incomplete snapshot; never evaluate it as the verified inventory.
    state.mcpInventory = null;
    requestCodexAppServerMcpStatusList(proc, state, { force: true });
    return true;
  }
  if (parsed?.error) {
    await failCodexAppServerMcpReadiness(runId, state, terminate, 'MCP_DISCOVERY_UNSUPPORTED');
    return true;
  }
  const inventory = readCodexAppServerMcpStatusList(parsed);
  if (!inventory) {
    await failCodexAppServerMcpReadiness(runId, state, terminate, 'MCP_DISCOVERY_INVALID');
    return true;
  }
  state.mcpInventory = inventory;
  const readiness = getCodexAppServerMcpReadiness(state);
  if (readiness.state === 'failed') {
    await failCodexAppServerMcpReadiness(runId, state, terminate, readiness.reasonCode);
    return true;
  }
  if (readiness.state === 'ready') {
    state.mcpReady = true;
    state.mcpStartupFallbackReady = false;
    if (state.mcpReadinessTimer) {
      clearTimeout(state.mcpReadinessTimer);
      state.mcpReadinessTimer = null;
    }
    clearCodexAppServerMcpStartupFallback(state);
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      json: {
        type: 'status',
        role: 'system',
        content: 'MCP ready (tool schema verified)',
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
        codexMcpStatus: 'ready',
        codexMcpReadiness: 'verified',
        codexMcpServer: readiness.serverName || state.mcpExpectedServerName,
        codexMcpTools: readiness.toolNames || [],
      },
    });
    // The inventory response is the verification edge. Only now may the
    // provider turn start, so an early empty inventory cannot be mistaken for
    // a missing required tool.
    if (state.threadId && !state.startedTurn) {
      maybeStartCodexAppServerTurn(proc, state, {
        method: 'thread/started',
        params: { thread: { id: state.threadId } },
      });
    }
    return true;
  }
  return true;
}

async function observeCodexAppServerMcpStartupStatus(runId, state, proc, parsed, terminate) {
  if (!state?.mcpRequired) return false;
  const startup = readCodexAppServerMcpStartupStatus(parsed);
  const requiredServerNames = new Set(
    (state.mcpRequiredServers || []).map((server) => server?.name).filter(Boolean),
  );
  if (!startup || !requiredServerNames.has(startup.name)) return false;
  state.mcpStartupStatuses[startup.name] = startup.status;
  if (startup.status === 'failed') {
    await failCodexAppServerMcpReadiness(runId, state, terminate, 'MCP_STARTUP_FAILED');
    return true;
  }
  if (startup.status === 'cancelled') {
    await failCodexAppServerMcpReadiness(runId, state, terminate, 'MCP_STARTUP_CANCELLED');
    return true;
  }
  if (startup.status === 'ready') {
    state.mcpReadyStatusObserved = true;
    // The startup notification is the readiness edge; the preceding status
    // list may have been captured while the server was still starting and can
    // legitimately expose an empty tool map. Always refresh the full inventory
    // after this edge before evaluating required tool schemas.
    state.mcpInventory = null;
    requestCodexAppServerMcpStatusList(proc, state, { force: true });
    armCodexAppServerMcpStartupFallback(runId, state, proc);
  }
  return true;
}

function isCodexAppServerStaleResumeError(parsed, state) {
  if (!state?.useResume || state.resumeRecoveryAttempted) return false;
  if (parsed?.id !== state.threadRequestId || !parsed?.error) return false;
  return payloadContainsText(parsed, /no rollout found for thread id/i);
}

// Codex's thread index can be missing even when the authorized home still
// contains the complete rollout. Try its verified path before creating a new
// thread, so a recoverable history is not silently replaced.
export async function retryManagedCodexRolloutResume(proc, state, codexHomeDir, findRollout = findManagedCodexRollout, accountSources = []) {
  if (!state?.useResume || state.rolloutResumeAttempted || !state.threadId) return false;
  state.rolloutResumeAttempted = true;
  let rolloutPath;
  if (accountSources.length) {
    const auth = await readJsonIfPresent(join(codexHomeDir, 'auth.json'), readFile);
    rolloutPath = await findAccountCodexRollout([dirname(codexHomeDir), ...accountSources], codexRolloutAccountId(auth), state.threadId);
  } else rolloutPath = await findRollout(codexHomeDir, state.threadId);
  if (!rolloutPath) return false;
  state.rolloutPath = rolloutPath;
  state.threadRequestId = state.nextControlRequestId++;
  state.threadRequestSent = false;
  state.providerStage = 'thread_resume_by_rollout';
  if (!writeCodexAppServerThreadStart(proc, state)) throw new Error('Codex rollout resume could not write to app-server');
  return true;
}

function recoverCodexAppServerFromStaleResume(proc, state) {
  if (!state || state.resumeRecoveryAttempted) return false;
  if (state.turnRetryTimer) {
    clearTimeout(state.turnRetryTimer);
    state.turnRetryTimer = null;
  }
  state.resumeRecoveryAttempted = true;
  state.useResume = false;
  state.threadId = '';
  state.rolloutPath = '';
  state.prompt = state.freshRecoveryPrompt || state.prompt;
  state.developerInstructions = state.freshRecoveryDeveloperInstructions || state.developerInstructions;
  state.threadRequestId = state.nextControlRequestId;
  state.nextControlRequestId += 1;
  state.turnId = '';
  state.startedTurn = false;
  state.approvalPolicyVerified = false;
  state.threadRequestSent = false;
  state.mcpStatusRequestId = null;
  state.mcpStatusRequestAfterReady = false;
  state.mcpDiscoveryStarted = false;
  state.mcpInventory = null;
  state.mcpReadyStatusObserved = false;
  state.mcpReady = false;
  state.mcpStartupFallbackReady = false;
  state.mcpStartupStatuses = Object.create(null);
  if (state.mcpReadinessTimer) {
    clearTimeout(state.mcpReadinessTimer);
    state.mcpReadinessTimer = null;
  }
  clearCodexAppServerMcpStartupFallback(state);
  state.goalApplied = false;
  state.goalClearRequestId = null;
  state.goalSetRequestId = null;
  state.terminalSeen = false;
  state.hadError = false;
  state.failureReason = '';
  state.providerErrorCode = null;
  state.providerErrorMethod = '';
  state.providerStage = 'fresh_thread_recovery';
  state.freshRecoveryRequested = true;
  state.activeItems.clear();
  state.idleTerminationReason = '';
  const written = writeCodexAppServerThreadStart(proc, state);
  if (!written) {
    markCodexAppServerFailure(
      state,
      { error: { code: 'CODEX_STDIN_CLOSED', message: 'Codex app-server closed stdin during stale-resume recovery' } },
      'Codex app-server closed stdin during stale-resume recovery',
    );
  }
  return written;
}

function armCodexAppServerStartupTimeout(runId, state, terminate, timeoutMs) {
  if (!state || state.startupTimer || state.terminalSeen || state.turnId) return;
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS;
  state.startupTimer = setTimeout(() => {
    state.startupTimer = null;
    if (state.terminalSeen || state.turnId) return;
    state.accountModelCatalog?.cancel();
    const phase = state.providerStage || 'startup';
    const reason = `Codex app-server startup timed out during ${phase} after ${Math.round(delay / 1000)} seconds`;
    markCodexAppServerFailure(
      state,
      { error: { code: 'CODEX_APP_SERVER_STARTUP_TIMEOUT', message: reason } },
      reason,
    );
    void logSidecarDiagnostic(runId, reason, {
      phase,
      startupTimeoutMs: delay,
      threadId: state.threadId || null,
      useResume: state.useResume === true,
    });
    void terminate?.();
  }, delay);
  state.startupTimer.unref?.();
}

async function validateCodexProviderHome(codexHomeDir) {
  const homeDir = typeof codexHomeDir === 'string' ? codexHomeDir.trim() : '';
  if (!homeDir) return;
  const authPath = join(homeDir, 'auth.json');
  try {
    await access(homeDir, constants.R_OK | constants.X_OK);
    await access(authPath, constants.R_OK);
  } catch (error) {
    const failure = new Error(`Codex provider home is unavailable: ${homeDir}`);
    failure.code = 'CODEX_PROVIDER_HOME_UNAVAILABLE';
    failure.causeCode = error?.code || 'ACCESS_CHECK_FAILED';
    throw failure;
  }
}

function maybeApplyCodexAppServerGoal(proc, state) {
  if (!state || state.goalApplied || !state.threadId) return false;
  const intent = state.codexGoal;
  if (!intent || typeof intent !== 'object') return false;
  const objective = typeof intent.objective === 'string' ? intent.objective.trim() : '';
  if (!objective) return false;
  state.goalApplied = true;
  // One active goal per codex thread: clear first (a fresh thread has no goal,
  // so the clear errors with "no goal" — that response is swallowed in
  // recordStdoutLine), then set. Both request ids are allocated from the same
  // monotonic counter steer/interrupt use; goal apply runs before turn/start,
  // so they cannot collide with mid-turn control requests.
  const clearId = state.nextControlRequestId;
  state.nextControlRequestId += 1;
  state.goalClearRequestId = clearId;
  const setId = state.nextControlRequestId;
  state.nextControlRequestId += 1;
  state.goalSetRequestId = setId;
  writeCodexAppServerMessage(proc, buildCodexAppServerThreadGoalClearMessage({ id: clearId, threadId: state.threadId }));
  const setMessage = buildCodexAppServerThreadGoalSetMessage({
    id: setId,
    threadId: state.threadId,
    objective,
    tokenBudget: Number.isFinite(intent.tokenBudget) && intent.tokenBudget > 0 ? intent.tokenBudget : undefined,
  });
  if (setMessage) {
    writeCodexAppServerMessage(proc, setMessage);
  }
  return true;
}

export function isUnrequestedCodexThreadEvent(state, parsed) {
  return Boolean(state && !state.threadRequestSent && readCodexAppServerEventThreadId(parsed));
}

export function maybeStartCodexAppServerTurn(proc, state, parsed) {
  if (!state || state.startedTurn || state.terminalSeen || state.hadError
      || state.startupCancelled || state.needsAccountModelCatalog || !state.threadRequestSent) return false;
  const threadId = readCodexAppServerThreadId(parsed);
  if (!threadId) return false;
  state.threadId = threadId;
  if (state.agentocApprovalGate && state.approvalPolicyVerified !== true) {
    state.providerStage = 'verifying_approval_policy';
    return false;
  }
  state.providerStage = 'thread_started';

  // MCP timing fix: Do not start turn until startup and the required tool
  // inventory have both been verified. The readiness object is authoritative;
  // the boolean alone can be stale during the startup-status refresh window.
  if (state.mcpRequired) {
    const readiness = getCodexAppServerMcpReadiness(state);
    const startupFallbackReady = state.mcpStartupFallbackReady === true
      && areRequiredCodexMcpServersStartupReady(state);
    if (readiness.state !== 'ready' && !startupFallbackReady) {
      state.providerStage = 'waiting_mcp_readiness';
      requestCodexAppServerMcpStatusList(proc, state);
      return false;
    }
    state.mcpReady = true;
  }

  // Apply the goal intent before turn/start so codex tracks it for this turn.
  maybeApplyCodexAppServerGoal(proc, state);
  const written = writeCodexAppServerMessage(proc, buildCodexAppServerTurnStartMessage({
    threadId,
    text: state.prompt,
    clientUserMessageId: state.requestId,
    cwd: state.cwd,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    interactionMode: state.interactionMode,
    permissionMode: state.permissionMode,
    agentocApprovalGate: state.agentocApprovalGate,
    executionEnvironment: state.executionEnvironment,
  }));
  if (written) state.startedTurn = true;
  if (written) state.providerStage = 'turn_start_sent';
  return written;
}

async function maybeConsumeCodexAppServerGoalResponse(runId, state, parsed) {
  if (!state || !parsed || typeof parsed !== 'object') return false;
  if (parsed.id !== state.goalClearRequestId && parsed.id !== state.goalSetRequestId) {
    return false;
  }
  // This is a threadGoal/clear or threadGoal/set RPC response. Swallow it so it
  // does not surface as chat status: the expected clear-on-fresh-thread "no
  // goal" error would otherwise render as an error line, and a successful set
  // is already reflected by the thread/goal/updated notification that follows.
  if (parsed.id === state.goalClearRequestId) {
    state.goalClearRequestId = null;
    return true;
  }
  state.goalSetRequestId = null;
  if (parsed.error) {
    const reason = readStructuredProviderFailureReason(parsed, 'codex goal not applied');
    const content = `codex goal not applied: ${String(reason || 'unknown error').slice(0, 160)}`;
    // DS-14: line was a pure duplicate of json — readers prefer `json`.
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      json: { type: 'status', content },
    });
  }
  return true;
}

function maybeCaptureCodexAppServerTurnId(state, parsed) {
  if (!state) return '';
  if (!isCodexAppServerStateEvent(state, parsed)) return '';
  const isTurnStart = parsed?.method === 'turn/started'
    || (parsed?.id === CODEX_APP_SERVER_REQUEST_IDS.turn && !!parsed?.result?.turn);
  // Some app-server versions can flush turn/completed before the
  // turn/started notification reaches the client. If this is the first
  // completion for the turn we already started, use its id as the correlation
  // edge instead of leaving the Run waiting for an "accepted" terminal frame.
  const isFirstCompletion = parsed?.method === 'turn/completed'
    && state.startedTurn === true
    && !state.turnId;
  if (!isTurnStart && !isFirstCompletion) return '';
  const turnId = isFirstCompletion
    ? readCodexAppServerEventTurnId(parsed)
    : readCodexAppServerTurnId(parsed);
  if (!turnId) return '';
  if (state.turnId && state.turnId !== turnId) return '';
  state.turnId = turnId;
  state.providerStage = 'turn_started';
  if (state.resumeRecoveryAttempted && !state.useResume) {
    state.freshRecoveryRequested = false;
  }
  if (state.startupTimer) {
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
  }
  return turnId;
}

async function markCodexAppServerSteerSent(runId, steerId) {
  const sentIds = Array.isArray(steerId) ? steerId : [steerId];
  const normalizedIds = new Set(
    sentIds
      .map((value) => (typeof value === 'string' ? value : ''))
      .filter(Boolean),
  );
  if (!runId || normalizedIds.size === 0) return;
  const sentAt = nowIso();
  await updateRun(runId, (current) => ({
    ...current,
    appServerSteerQueue: Array.isArray(current?.appServerSteerQueue)
      ? current.appServerSteerQueue.map((entry) => (
        normalizedIds.has(entry?.id)
          ? { ...entry, sentAt: entry.sentAt || sentAt, state: 'sent' }
          : entry
      ))
      : [],
  }));
}

async function flushCodexAppServerSteerQueue(proc, state, run) {
  if (!state || !state.threadId || !state.turnId || state.terminalSeen) return;
  const queue = Array.isArray(run?.appServerSteerQueue) ? run.appServerSteerQueue : [];
  for (const entry of queue) {
    const steerId = typeof entry?.id === 'string' ? entry.id : '';
    if (!steerId || state.sentSteerIds.has(steerId) || entry?.state === 'sent') continue;
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (!text.trim()) continue;
    const requestId = state.nextControlRequestId;
    state.nextControlRequestId += 1;
    if (writeCodexAppServerMessage(proc, buildCodexAppServerTurnSteerMessage({
      id: requestId,
      threadId: state.threadId,
      turnId: state.turnId,
      text,
      clientUserMessageId: typeof entry?.requestId === 'string' ? entry.requestId : '',
    }))) {
      state.sentSteerIds.add(steerId);
      await markCodexAppServerSteerSent(run.id, steerId);
    }
  }
}

function riskAuditFields(value) {
  const risk = value?.risk && typeof value.risk === 'object' ? value.risk : value;
  const riskTier = typeof value?.riskTier === 'string' && value.riskTier.trim()
    ? value.riskTier.trim()
    : (typeof risk?.tier === 'string' && risk.tier.trim() ? risk.tier.trim() : '');
  const policyVersion = typeof value?.riskPolicyVersion === 'string' && value.riskPolicyVersion.trim()
    ? value.riskPolicyVersion.trim()
    : (typeof risk?.policyVersion === 'string' && risk.policyVersion.trim() ? risk.policyVersion.trim() : '');
  const reasonCodes = Array.isArray(value?.riskReasonCodes)
    ? value.riskReasonCodes
    : (Array.isArray(risk?.reasons) ? risk.reasons.map((reason) => reason?.code || reason) : []);
  const normalizedReasonCodes = [...new Set(reasonCodes
    .map((code) => typeof code === 'string' ? code.trim() : '')
    .filter(Boolean))].slice(0, 8);
  const targetScope = typeof value?.riskTargetScope === 'string' && value.riskTargetScope.trim()
    ? value.riskTargetScope.trim()
    : (typeof risk?.signals?.targetScope === 'string' ? risk.signals.targetScope.trim() : '');
  return {
    ...(riskTier ? { riskTier } : {}),
    ...(policyVersion ? { riskPolicyVersion: policyVersion } : {}),
    ...(normalizedReasonCodes.length > 0 ? { riskReasonCodes: normalizedReasonCodes } : {}),
    ...(targetScope ? { riskTargetScope: targetScope } : {}),
    ...(typeof risk?.platform === 'string' && risk.platform ? { riskPlatform: risk.platform } : {}),
    ...(typeof risk?.confidence === 'string' && risk.confidence ? { riskConfidence: risk.confidence } : {}),
    ...(typeof risk?.signals?.needsPrivilegedExecution === 'boolean'
      ? { riskNeedsPrivilegedExecution: risk.signals.needsPrivilegedExecution }
      : {}),
  };
}

function serializeCodexAppServerApprovalForRun(approval, risk = null) {
  if (!approval?.approvalId) return null;
  return {
    approvalId: approval.approvalId,
    providerRequestId: approval.providerRequestId,
    providerRequestIdString: approval.providerRequestIdString,
    providerMethod: approval.providerMethod,
    kind: approval.kind,
    params: approval.params || {},
    request: approval.request || null,
    ...riskAuditFields(risk),
    state: 'pending',
    createdAt: nowIso(),
  };
}

function serializePrivilegedApprovalForRun(approval, op) {
  const record = serializeCodexAppServerApprovalForRun(approval, op?.risk);
  if (!record) return null;
  return {
    ...record,
    privileged: true,
    privilegedCategory: typeof op?.category === 'string' ? op.category : '',
    privilegedCommand: typeof op?.command === 'string' ? op.command : '',
    privilegedWrapperCommand: typeof op?.wrapperCommand === 'string' ? op.wrapperCommand : '',
  };
}

function markApprovalRecordAutoResponded(record, decision = 'approved') {
  if (!record) return record;
  return {
    ...record,
    state: 'responded',
    decision,
    respondedAt: nowIso(),
  };
}

function hasOpenPrivilegedApprovals(state) {
  if (!(state?.pendingApprovals instanceof Map)) return false;
  return Array.from(state.pendingApprovals.values()).some((entry) =>
    entry?.privileged === true && entry?.state !== 'responded');
}

function clearPrivilegedBatchOpenIfResolved(state) {
  if (!state || state.privilegedBatchOpen !== true) return;
  if (!hasOpenPrivilegedApprovals(state)) state.privilegedBatchOpen = false;
}

// Route the gate decision to the risk-gated path when the session has opted into
// a risk mode (safe/recommended), OR when the provider runs in a gated
// permission mode that emits one permission request per tool call — a legacy
// session (no riskMode) on plan / on-request modes would otherwise surface one
// approval card per tool call, which is the exact fatigue the risk model exists
// to avoid. User-facing gates (AskUserQuestion, ExitPlanMode) always stay on the
// user-visible path so questions are shown and plans are reviewed, never
// auto-answered by the classifier. Everything else falls back to the legacy
// privileged gate so bypass-mode sessions stay unchanged. Pure dispatch — the
// gate functions share the {decision, reason, op} contract.
async function decideRunGate(approval, state) {
  if (isUserFacingGateKind(approval?.kind || '')) {
    return {
      decision: PRIVILEGED_GATE_DECISION.PASS,
      reason: `user-facing ${approval.kind} gate (question/plan review path)`,
    };
  }
  if (WORKBENCH_EXECUTION_POLICY) {
    return { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: 'Workbench operator requires explicit approval' };
  }
  const riskMode = typeof state?.riskMode === 'string' ? state.riskMode : '';
  if (process.platform === 'win32' && (['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(riskMode)
      || isGatedPermissionMode(state?.permissionMode || ''))) {
    if (isManagedLearningProfileWrite(approval)) {
      return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'managed learning profile write' };
    }
    return decideWindowsApproval(approval, state);
  }
  const gated = ['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(riskMode)
    || isGatedPermissionMode(state?.permissionMode || '');
  if (gated) {
    if (isManagedLearningProfileWrite(approval)) {
      return { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'managed learning profile write' };
    }
    return decideRiskGate(approval, {
      riskMode: ['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(riskMode) ? riskMode : 'recommended',
      cwd: state.cwd,
      projectRoot: state.projectRoot || '',
      home: state.home || '',
      riskContext: state.riskContext || null,
    });
  }
  return decidePrivilegedGate(approval, {
    privilegedMode: state.privilegedMode === true,
    cwd: state.cwd,
  });
}

function isUnattendedPermissionMode(state) {
  return ['full-auto', 'conservative-auto'].includes(state?.riskMode);
}

async function denyUnattendedPermissionRequest(runId, state, approval, proc, provider, gateDecision = null) {
  const gateReason = typeof gateDecision?.reason === 'string' && gateDecision.reason.trim()
    ? gateDecision.reason.trim()
    : 'request did not qualify for automatic approval';
  const policyMode = typeof state?.riskMode === 'string' && state.riskMode.trim()
    ? state.riskMode.trim()
    : 'unattended';
  const auditReason = `${policyMode}: ${gateReason}`;
  const message = provider === 'codex'
    ? buildCodexAppServerApprovalResponseMessage(approval, 'deny')
    : buildClaudeBidiApprovalResponseMessage(approval, 'deny', null, {
      message: `Ragent automatically denied this tool request under the ${policyMode} policy: ${gateReason}.`,
    });
  const sent = message && (provider === 'codex'
    ? writeCodexAppServerMessage(proc, message)
    : writeClaudeBidiMessage(proc, message));
  if (!sent) {
    const error = new Error('Unable to deny unattended permission request');
    error.code = 'UNATTENDED_PERMISSION_DENIAL_FAILED';
    throw error;
  }
  await appendRunSpoolRecord(runId, {
    ts: nowIso(),
    stream: 'stdout',
    json: {
      type: 'agentoc.approval_response',
      approvalId: approval.approvalId,
      provider,
      decision: 'denied',
      status: 'denied',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''),
      providerMethod: approval.providerMethod || '',
      autoDenied: true,
      reason: auditReason,
      ...riskAuditFields(gateDecision?.risk),
    },
  });
  const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval));
  if (record) state.pendingApprovals.set(approval.approvalId, record);
  return record;
}

function isCurrentCodexAppServerMcpRequest(approval, state) {
  const params = approval?.params || {};
  const requestThreadId = typeof params.threadId === 'string' ? params.threadId.trim() : '';
  const requestTurnId = typeof params.turnId === 'string' ? params.turnId.trim() : '';
  if (requestThreadId && state?.threadId && requestThreadId !== state.threadId) return false;
  if (requestTurnId && state?.turnId && requestTurnId !== state.turnId) return false;
  return true;
}

function isRequiredMcpTool(state, serverName, toolName) {
  const requirement = (state?.mcpRequiredServers || []).find((server) => server?.name === serverName);
  if (requirement) return requirement.requiredToolNames?.includes(toolName) === true;
  return serverName === state?.mcpExpectedServerName
    && state?.mcpRequiredToolNames?.includes(toolName) === true;
}

function isAutoApprovedMcpServer(state, serverName) {
  if (state?.mcpAutoApproveServerNames instanceof Set && state.mcpAutoApproveServerNames.size > 0) {
    return state.mcpAutoApproveServerNames.has(serverName);
  }
  return serverName === state?.mcpExpectedServerName;
}

function withCurrentCodexFileChanges(approval, state) {
  if (approval?.providerMethod !== 'item/fileChange/requestApproval') return approval;
  const params = approval.params && typeof approval.params === 'object' ? approval.params : {};
  if (Array.isArray(params.changes) && params.changes.length) return approval;
  const itemId = typeof params.itemId === 'string' ? params.itemId.trim() : '';
  const item = itemId && state?.activeItems instanceof Map ? state.activeItems.get(itemId) : null;
  if (!item || item.type !== 'fileChange' || !Array.isArray(item.changes) || !item.changes.length) return approval;
  return { ...approval, params: { ...params, changes: item.changes } };
}

export async function trackCodexAppServerApprovalRequest(runId, state, parsed, proc, { safeDeleteHelperPath = join(PROJECT_ROOT, 'bin', 'agentoc-safe-delete.exe'), cliReadHelperPath = join(PROJECT_ROOT, 'bin', 'agentoc-cli-read-bridge.exe'), searchHelperPath = join(PROJECT_ROOT, 'bin', 'agentoc-safe-search.exe') } = {}) {
  if (!state || !parsed) return null;
  const approval = readCodexAppServerApprovalRequest(parsed);
  if (!approval?.approvalId) return null;
  // A shared app-server may report requests for another thread or turn. Never
  // answer those using this run's workspace and approval policy.
  const requestThread = typeof approval.params?.threadId === 'string' ? approval.params.threadId.trim() : '';
  const requestTurn = typeof approval.params?.turnId === 'string' ? approval.params.turnId.trim() : '';
  if ((requestThread && state.threadId && requestThread !== state.threadId)
      || (requestTurn && state.turnId && requestTurn !== state.turnId)) return null;
  // App Server can replay a request notification while the run is still alive.
  // Reuse the first decision/card for that JSON-RPC id: responding twice can
  // produce protocol errors, and an already auto-approved MCP request must not
  // fall through into a user-facing elicitation card on replay.
  if (state.pendingApprovals instanceof Map && state.pendingApprovals.has(approval.approvalId)) {
    return state.pendingApprovals.get(approval.approvalId) || null;
  }
  if (state.autoApprovedMcpRequestIds instanceof Set && state.autoApprovedMcpRequestIds.has(approval.approvalId)) {
    return null;
  }
  const managedMcp = readCodexAppServerManagedMcpRequest(parsed);

  if (managedMcp
    && state.mcpRequired === true
    && state.startedTurn === true
    && isAutoApprovedMcpServer(state, managedMcp.mcpServerName)
    && isCurrentCodexAppServerMcpRequest(approval, state)
    && !state.autoApprovedMcpRequestIds.has(approval.approvalId)) {
    const message = buildCodexAppServerApprovalResponseMessage(approval, 'approve');
    if (message && writeCodexAppServerMessage(proc, message)) {
      state.autoApprovedMcpRequestIds.add(approval.approvalId);
      await appendRunSpoolRecord(runId, {
        ts: nowIso(),
        stream: 'stdout',
        json: {
          type: 'agentoc.approval_response',
          approvalId: approval.approvalId,
          provider: 'codex',
          decision: 'approved',
          status: 'approved',
          providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''),
          providerMethod: approval.providerMethod || '',
          autoApproved: true,
          mcpServerName: managedMcp.mcpServerName,
          reason: 'run-scoped managed MCP server',
        },
      });
      return null;
    }
  }

  // Privileged-approval gate (P1c-3): in privileged mode, intercept the gate
  // and decide whether to auto-allow (ordinary command) or accumulate (real
  // privileged op). Non-privileged sessions pass through unchanged.
  // MCP elicitation is not a shell/file operation. Never let the generic risk
  // classifier auto-allow an unknown server; it must reach the user approval
  // path and use the provider-specific elicitation response shape.
  const controlledInstall = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !managedMcp
    && await verifyCodexWindowsInstallBridgeApproval({ approval, state, runId, nodePath: process.execPath,
      scriptPath: join(PROJECT_ROOT, 'scripts', 'agentoc-windows-install-bridge.mjs') });
  const controlledDelete = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !managedMcp
    && await verifyCodexWindowsSafeDeleteApproval({ approval, state, runId, helperPath: safeDeleteHelperPath });
  const controlledAsset = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !managedMcp
    && await verifyCodexWindowsCliAssetApproval({ approval, state, runId, helperPath: cliReadHelperPath, port: Number(CHAT_PORT) });
  const controlledTrigger = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !managedMcp
    && await verifyCodexWindowsTriggerApproval({ approval, state, runId, helperPath: cliReadHelperPath, port: Number(CHAT_PORT) });
  const controlledSearch = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !managedMcp
    && await verifyCodexWindowsBoundSearchApproval({ approval, state, helperPath: searchHelperPath });
  const controlledListing = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !managedMcp
    && await verifyCodexWindowsWildcardNameApproval({ approval, state, helperPath: searchHelperPath });
  const gateDecision = controlledTrigger
    ? { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'controlled current-session trigger operation' }
    : controlledListing
    ? { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'pinned local directory name listing' }
    : controlledSearch
    ? { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'handle-bound verified search' }
    : controlledAsset
    ? { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'controlled current-session asset publication' }
    : controlledDelete
    ? { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'handle-bound workspace deletion' }
    : controlledInstall
    ? { decision: PRIVILEGED_GATE_DECISION.AUTO_ALLOW, reason: 'controlled Windows installation' }
    : managedMcp || approval.providerMethod === 'mcpServer/elicitation/request'
    ? { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'MCP elicitation requires explicit server binding or user approval' }
    : await decideRunGate(withCurrentCodexFileChanges(approval, state), state);

  if (isUnattendedPermissionMode(state)
      && gateDecision.decision !== PRIVILEGED_GATE_DECISION.AUTO_ALLOW) {
    return denyUnattendedPermissionRequest(runId, state, approval, proc, 'codex', gateDecision);
  }

  if (gateDecision.decision === PRIVILEGED_GATE_DECISION.AUTO_ALLOW) {
    // Auto-allow: write the gate response directly to stdin so gated mode does
    // not stall every read/edit/ordinary command. Zero extra latency, no
    // pollution of user-visible approval state.
    const message = buildCodexAppServerApprovalResponseMessage(approval, 'approve');
    if (message && proc) {
      writeCodexAppServerMessage(proc, message);
      const event = {
        type: 'agentoc.approval_response',
        approvalId: approval.approvalId,
        provider: 'codex',
        decision: 'approved',
        status: 'approved',
        providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''),
        providerMethod: approval.providerMethod || '',
        autoApproved: true,
        reason: gateDecision.reason || 'auto-allow',
        ...riskAuditFields(gateDecision.risk),
      };
      // DS-14: `line = JSON.stringify(json)` is a pure duplicate (readers
      // prefer `json`); normalizeSpoolRecord drops it anyway, so don't build it.
      await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: event });
    }
    // Still track it so the flush path can find the pending approval if needed.
    const record = markApprovalRecordAutoResponded(
      serializeCodexAppServerApprovalForRun(approval, gateDecision.risk),
    );
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  if (gateDecision.decision === PRIVILEGED_GATE_DECISION.ACCUMULATE) {
    // Real privileged op: hold the gate (no auto-response) and enqueue into the
    // per-turn batch. The quiescence-debounce drain (P1c-4) — armed just below —
    // treats the batch as complete once gates stop arriving and surfaces it into
    // waiting_user. Default OFF; a pure no-op unless privilegedMode is on.
    if (gateDecision.op) {
      state.privilegedTurnOps.push(gateDecision.op);
    }
    armPrivilegedBatchDrain(runId, state);
    // Still track the pending approval so the eventual resolve (P1c-6) can
    // write the gate response with the real command.
    const record = serializePrivilegedApprovalForRun(approval, gateDecision.op);
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  // PASS/PROMPT or unknown: normal flow (non-privileged mode, a user-facing
  // gate, or a request the risk classifier deliberately could not prove safe).
  // Keep the risk result on the pending record so owner approval and projection
  // retain the same provider-neutral audit dimensions as auto-allow.
  const record = serializeCodexAppServerApprovalForRun(approval, gateDecision.risk);
  if (!record) return null;
  state.pendingApprovals.set(approval.approvalId, record);
  await updateRun(runId, (current) => {
    const existing = Array.isArray(current?.appServerPendingApprovals)
      ? current.appServerPendingApprovals
      : [];
    if (existing.some((entry) => entry?.approvalId === approval.approvalId)) {
      return current;
    }
    return {
      ...current,
      appServerPendingApprovals: [...existing, record],
    };
  });
  return record;
}

export async function trackClaudeBidiApprovalRequest(runId, state, parsed, proc, { safeDeleteHelperPath = join(PROJECT_ROOT, 'bin', 'agentoc-safe-delete.exe'), cliReadHelperPath = join(PROJECT_ROOT, 'bin', 'agentoc-cli-read-bridge.exe'), searchHelperPath = join(PROJECT_ROOT, 'bin', 'agentoc-safe-search.exe') } = {}) {
  if (!state || !parsed) return null;
  const approval = readClaudeBidiApprovalRequest(parsed);
  if (!approval?.approvalId) return null;
  // Claude's bidi stream can also replay a control_request. Reuse the first
  // automatic response or owner card for this request id.
  if (state.pendingApprovals instanceof Map && state.pendingApprovals.has(approval.approvalId)) {
    return state.pendingApprovals.get(approval.approvalId) || null;
  }
  if (state.autoApprovedMcpRequestIds instanceof Set && state.autoApprovedMcpRequestIds.has(approval.approvalId)) {
    return null;
  }
  const managedMcp = readClaudeBidiManagedMcpRequest(parsed);
  const isMcpTool = isClaudeBidiMcpToolName(approval.params?.tool_name);

  if (managedMcp
    && state.mcpRequired === true
    && state.turnActive === true
    && isRequiredMcpTool(state, managedMcp.mcpServerName, managedMcp.mcpToolName)
    && !state.autoApprovedMcpRequestIds.has(approval.approvalId)) {
    const message = buildClaudeBidiManagedMcpResponse(approval, 'approve');
    if (message && writeClaudeBidiMessage(proc, message)) {
      state.autoApprovedMcpRequestIds.add(approval.approvalId);
      await appendRunSpoolRecord(runId, {
        ts: nowIso(),
        stream: 'stdout',
        json: {
          type: 'agentoc.approval_response',
          approvalId: approval.approvalId,
          provider: 'claude',
          decision: 'approved',
          status: 'approved',
          providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''),
          providerMethod: approval.providerMethod || '',
          autoApproved: true,
          mcpServerName: managedMcp.mcpServerName,
          mcpToolName: managedMcp.mcpToolName,
          reason: 'run-scoped managed MCP tool',
        },
      });
      return null;
    }
  }

  if (process.platform === 'win32' && !isMcpTool && state.turnActive === true && approval.kind === 'command' &&
      ['PowerShell', 'Bash'].includes(approval.params?.tool_name) &&
      await needsWindowsElevationGuidance(approval.params?.input?.command, approval.params.tool_name)) {
    const binding = state.windowsManagedActionBinding;
    const reason = windowsElevationGuidance(state.windowsManagedActionChannel === true && binding?.runId === runId);
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'deny', null, { message: reason });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to provide managed elevation guidance');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: { type: 'agentoc.approval_response',
      approvalId: approval.approvalId, provider: 'claude', decision: 'denied', status: 'denied', autoDenied: true,
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '', reason } });
    return null;
  }

  // Privileged-approval gate (P1c-3): in privileged mode, intercept the gate
  // and decide whether to auto-allow (ordinary command) or accumulate (real
  // privileged op). Non-privileged sessions pass through unchanged.
  // Any Claude MCP tool that is not the exact run-scoped allowlist entry must
  // remain an explicit user decision, even in a risk-gated session.
  let gateDecision = isMcpTool
    ? { decision: PRIVILEGED_GATE_DECISION.PASS, reason: 'MCP tool requires explicit server binding or user approval' }
    : await decideRunGate(approval, state);

  const cwdTransition = process.platform !== 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool && gateDecision.decision === PRIVILEGED_GATE_DECISION.AUTO_ALLOW
    ? await buildClaudePosixCwdTransition({ approval, state }) : null;
  if (cwdTransition?.review) {
    gateDecision = { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: cwdTransition.reason,
      risk: { ...gateDecision.risk, tier: 'danger', reasons: [{ code: 'posix_cwd_sensitive_target', message: cwdTransition.reason }] } };
  } else if (cwdTransition) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: cwdTransition.updatedInput });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send bound directory change response');
    state.cwdTransitions ||= new Map();
    state.cwdTransitions.set(cwdTransition.toolUseId, { from: cwdTransition.from, to: cwdTransition.to });
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'directory change bound to verified execution context', ...riskAuditFields(gateDecision.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, gateDecision.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  const posixRipgrep = process.platform !== 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool && gateDecision.decision === PRIVILEGED_GATE_DECISION.AUTO_ALLOW
    ? await buildClaudePosixRipgrepBridge({ approval, state }) : null;
  if (posixRipgrep?.review) {
    gateDecision = { decision: PRIVILEGED_GATE_DECISION.PROMPT, reason: posixRipgrep.reason,
      risk: { ...gateDecision.risk, tier: 'danger', reasons: [{ code: 'posix_ripgrep_sensitive_target', message: posixRipgrep.reason }] } };
  } else if (posixRipgrep) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: posixRipgrep.updatedInput });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send bound ripgrep response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'ripgrep bound to execution directory and sensitive exclusions', ...riskAuditFields(gateDecision.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, gateDecision.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  const deleteBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool
    ? await buildWindowsSafeDeleteBridge({ approval, state, runId, helperPath: safeDeleteHelperPath }) : null;
  const listingBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool && gateDecision.decision !== PRIVILEGED_GATE_DECISION.AUTO_ALLOW
    ? await buildWindowsWildcardNameBridge({ approval, state, helperPath: searchHelperPath }) : null;
  if (listingBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: { ...approval.params.input, command: listingBridge.updatedCommand } });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send bound wildcard listing response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'pinned local directory name listing', ...riskAuditFields(listingBridge.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, listingBridge.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }
  const searchGlobBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool && gateDecision.reason === 'wildcard search requires bound targets'
    ? await buildWindowsSelectStringGlobBridge({ approval, state, helperPath: searchHelperPath }) : null;
  if (searchGlobBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: { ...approval.params.input, command: searchGlobBridge.updatedCommand } });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send bound wildcard search response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'wildcard search bound to verified file handles', ...riskAuditFields(searchGlobBridge.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, searchGlobBridge.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }
  const ripgrepBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool
    && ['ripgrep configuration is not disabled', 'ripgrep sensitive exclusions are not enforced', 'recursive file operation needs verification'].includes(gateDecision.reason)
    ? await buildClaudeWindowsRipgrepBridge({ approval, state }) : null;
  if (ripgrepBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: { ...approval.params.input, command: ripgrepBridge.updatedCommand } });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send controlled ripgrep response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'ripgrep configuration disabled for verified read', ...riskAuditFields(ripgrepBridge.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, ripgrepBridge.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }
  const defaultFileBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool
    && ['file targets are unavailable', 'working directory is not attested'].includes(gateDecision.reason) ? await buildClaudeWindowsDefaultFileToolBridge({ approval, state }) : null;
  if (defaultFileBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: defaultFileBridge.updatedInput });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send bound file search response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'file tool bound to session directory', ...riskAuditFields(defaultFileBridge.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, defaultFileBridge.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }
  const relativeOperationBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool && !deleteBridge
    && ['working directory is not attested', 'ripgrep configuration is not disabled', 'ripgrep sensitive exclusions are not enforced', 'ripgrep path cannot be resolved', 'recursive file operation needs verification', 'curl configuration is not disabled', 'Git command is not on the read-only allowlist'].includes(gateDecision.reason)
    ? await buildClaudeWindowsRelativeOperationBridge({ approval, state }) : null;
  if (relativeOperationBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: relativeOperationBridge.updatedInput });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send working-directory-bound operation response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'operation bound to execution working directory', ...riskAuditFields(relativeOperationBridge.risk),
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, relativeOperationBridge.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }
  if (deleteBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: { command: deleteBridge.updatedCommand } });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send controlled deletion response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'handle-bound workspace deletion',
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, gateDecision.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  const cliReadBridge = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY && !isMcpTool
    ? await buildWindowsCliReadBridge({ approval, state, runId, port: Number(CHAT_PORT), helperPath: cliReadHelperPath })
      || await buildWindowsCliAssetBridge({ approval, state, runId, port: Number(CHAT_PORT), helperPath: cliReadHelperPath }) : null;
  if (cliReadBridge) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: { command: cliReadBridge.updatedCommand } });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send controlled CLI response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: cliReadBridge.updatedCommand.includes(' asset-publish ') ? 'controlled current-session asset publication'
        : cliReadBridge.updatedCommand.includes(' trigger-create ') ? 'controlled current-session trigger creation' : 'controlled read-only CLI operation',
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, gateDecision.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  const installBridge = process.platform === 'win32' && !isMcpTool
    ? buildClaudeWindowsInstallBridge({ approval, state, runId, nodePath: process.execPath,
      scriptPath: join(PROJECT_ROOT, 'scripts', 'agentoc-windows-install-bridge.mjs') }) : null;
  if (installBridge && await checkWindowsInstallBridgeReadiness({ channel: state.windowsManagedActionBinding,
    command: installBridge.installCommand, requestKey: installBridge.requestKey })) {
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve', null, { updatedInput: { command: installBridge.updatedCommand } });
    if (!message || !writeClaudeBidiMessage(proc, message)) throw new Error('Unable to send controlled installation response');
    await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: {
      type: 'agentoc.approval_response', approvalId: approval.approvalId, provider: 'claude', decision: 'approved', status: 'approved',
      providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''), providerMethod: approval.providerMethod || '',
      autoApproved: true, reason: 'controlled Windows installation',
    } });
    const record = markApprovalRecordAutoResponded(serializeCodexAppServerApprovalForRun(approval, gateDecision.risk));
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  if (isUnattendedPermissionMode(state)
      && gateDecision.decision !== PRIVILEGED_GATE_DECISION.AUTO_ALLOW) {
    return denyUnattendedPermissionRequest(runId, state, approval, proc, 'claude', gateDecision);
  }

  if (gateDecision.decision === PRIVILEGED_GATE_DECISION.AUTO_ALLOW) {
    // Auto-allow: write the gate response directly to stdin so gated mode does
    // not stall every read/edit/ordinary command. Zero extra latency, no
    // pollution of user-visible approval state.
    const message = buildClaudeBidiApprovalResponseMessage(approval, 'approve');
    if (message && writeClaudeBidiMessage(proc, message)) {
      const event = {
        type: 'agentoc.approval_response',
        approvalId: approval.approvalId,
        provider: 'claude',
        decision: 'approved',
        status: 'approved',
        providerRequestId: approval.providerRequestIdString || String(approval.providerRequestId ?? ''),
        providerMethod: approval.providerMethod || '',
        autoApproved: true,
        reason: gateDecision.reason || 'auto-allow',
        ...riskAuditFields(gateDecision.risk),
      };
      // DS-14: `line = JSON.stringify(json)` is a pure duplicate (readers
      // prefer `json`); normalizeSpoolRecord drops it anyway, so don't build it.
      await appendRunSpoolRecord(runId, { ts: nowIso(), stream: 'stdout', json: event });
    } else {
      throw new Error('Unable to send Claude automatic approval response');
    }
    // Still track it so the flush path can find the pending approval if needed.
    const record = markApprovalRecordAutoResponded(
      serializeCodexAppServerApprovalForRun(approval, gateDecision.risk),
    );
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  if (gateDecision.decision === PRIVILEGED_GATE_DECISION.ACCUMULATE) {
    // Real privileged op: hold the gate (no auto-response) and enqueue into the
    // per-turn batch. The quiescence-debounce drain (P1c-4) — armed just below —
    // treats the batch as complete once gates stop arriving and surfaces it into
    // waiting_user. Default OFF; a pure no-op unless privilegedMode is on.
    if (gateDecision.op) {
      state.privilegedTurnOps.push(gateDecision.op);
    }
    armPrivilegedBatchDrain(runId, state);
    // Still track the pending approval so the eventual resolve (P1c-6) can
    // write the gate response with the real command.
    const record = serializePrivilegedApprovalForRun(approval, gateDecision.op);
    if (record) state.pendingApprovals.set(approval.approvalId, record);
    return record;
  }

  // PASS/PROMPT or unknown: normal flow (non-privileged mode, a user-facing
  // gate, or a request the risk classifier deliberately could not prove safe).
  // Keep the risk result on the pending record so owner approval and projection
  // retain the same provider-neutral audit dimensions as auto-allow.
  const record = serializeCodexAppServerApprovalForRun(approval, gateDecision.risk);
  if (!record) return null;
  if (state.turnActive === true && state.riskContextValid === true && state.approvalTurnSequence > 0 && state.requestId && state.cwd && state.approvalProcessId) {
    record.approvalGroupScope = { turnId: state.requestId, turnSequence: state.approvalTurnSequence, processId: state.approvalProcessId, cwd: state.cwd };
  }
  state.pendingApprovals.set(approval.approvalId, record);
  await updateRun(runId, (current) => {
    const existing = Array.isArray(current?.appServerPendingApprovals) ? current.appServerPendingApprovals : [];
    if (existing.some((entry) => entry?.approvalId === approval.approvalId)) return current;
    return { ...current, appServerPendingApprovals: [...existing, record] };
  });
  return record;
}

function findPendingCodexAppServerApproval(state, run, approvalId) {
  if (!approvalId) return null;
  const fromState = state?.pendingApprovals instanceof Map
    ? state.pendingApprovals.get(approvalId)
    : null;
  if (fromState) return fromState;
  const pending = Array.isArray(run?.appServerPendingApprovals)
    ? run.appServerPendingApprovals
    : [];
  return pending.find((entry) => entry?.approvalId === approvalId) || null;
}

async function markCodexAppServerApprovalResponseSent(runId, responseEntry, sentPayload = {}) {
  if (!runId || !responseEntry?.approvalId) return;
  const decision = formatCodexAppServerApprovalDecision(responseEntry.decision);
  await updateRun(runId, (current) => ({
    ...current,
    appServerPendingApprovals: Array.isArray(current?.appServerPendingApprovals)
      ? current.appServerPendingApprovals.map((entry) => (
        entry?.approvalId === responseEntry.approvalId
          ? {
              ...entry,
              state: 'responded',
              decision,
              respondedAt: entry.respondedAt || nowIso(),
            }
          : entry
      ))
      : [],
    appServerApprovalResponseQueue: Array.isArray(current?.appServerApprovalResponseQueue)
      ? current.appServerApprovalResponseQueue.map((entry) => (
        entry?.id === responseEntry.id
          ? {
              ...entry,
              state: 'sent',
              decision,
              sentAt: entry.sentAt || nowIso(),
              response: sentPayload,
            }
          : entry
      ))
      : [],
  }));
}

export async function flushCodexAppServerApprovalResponses(proc, state, run) {
  if (!state || state.terminalSeen) return;
  const queue = Array.isArray(run?.appServerApprovalResponseQueue)
    ? run.appServerApprovalResponseQueue
    : [];
  for (const entry of queue) {
    const responseId = typeof entry?.id === 'string' ? entry.id : '';
    const approvalId = typeof entry?.approvalId === 'string' ? entry.approvalId : '';
    if (!responseId || !approvalId || state.sentApprovalResponseIds.has(responseId) || entry?.state === 'sent') {
      continue;
    }
    const decision = normalizeCodexAppServerApprovalDecision(entry?.decision);
    if (!decision) continue;
    const pending = findPendingCodexAppServerApproval(state, run, approvalId);
    if (!pending) continue;
    const message = buildCodexAppServerApprovalResponseMessage(pending, decision);
    if (!message) continue;
    if (writeCodexAppServerMessage(proc, message)) {
      state.sentApprovalResponseIds.add(responseId);
      const inMemoryPending = state.pendingApprovals.get(approvalId);
      if (inMemoryPending) inMemoryPending.state = 'responded';
      clearPrivilegedBatchOpenIfResolved(state);
      state.lastControlActivityAt = Date.now();
      const formattedDecision = formatCodexAppServerApprovalDecision(decision);
      // DS-14: line was a pure duplicate of json — readers prefer `json`.
      await appendRunSpoolRecord(run.id, {
        ts: nowIso(),
        stream: 'stdout',
        json: {
          type: 'agentoc.approval_response',
          approvalId,
          provider: 'codex',
          decision: formattedDecision,
          status: formattedDecision === 'denied' || formattedDecision === 'cancelled' ? 'denied' : 'approved',
          providerRequestId: pending.providerRequestIdString || String(pending.providerRequestId ?? ''),
          providerMethod: pending.providerMethod || '',
          ...(entry?.privilegedBatchId ? { privilegedBatchId: entry.privilegedBatchId } : {}),
          ...(entry?.privilegedOpId ? { privilegedOpId: entry.privilegedOpId } : {}),
          ...(entry?.privilegedCategory ? { privilegedCategory: entry.privilegedCategory } : {}),
          ...(entry?.privilegedDecision ? { privilegedDecision: entry.privilegedDecision } : {}),
          ...(entry?.privilegedDecisionSource ? { privilegedDecisionSource: entry.privilegedDecisionSource } : {}),
          ...(entry?.privilegedExecutionState ? { privilegedExecutionState: entry.privilegedExecutionState } : {}),
          ...riskAuditFields(pending),
        },
      });
      await markCodexAppServerApprovalResponseSent(run.id, entry, message);
    }
  }
}

export async function flushClaudeBidiApprovalResponses(proc, state, run) {
  if (!state || state.terminalSeen) return;
  const queue = Array.isArray(run?.appServerApprovalResponseQueue) ? run.appServerApprovalResponseQueue : [];
  for (const entry of queue) {
    const responseId = typeof entry?.id === 'string' ? entry.id : '';
    const approvalId = typeof entry?.approvalId === 'string' ? entry.approvalId : '';
    if (!responseId || !approvalId || state.sentApprovalResponseIds.has(responseId) || entry?.state === 'sent') continue;
    const decision = normalizeCodexAppServerApprovalDecision(entry?.decision);
    const pending = findPendingCodexAppServerApproval(state, run, approvalId);
    if (!decision || !pending) continue;
    const message = buildClaudeBidiApprovalResponseMessage(pending, decision, entry?.choices, {
      message: describeManagedPrivilegeResponse(entry),
      updatedInput: entry?.updatedInput,
      customAnswer: entry?.customAnswer,
      customAnswers: entry?.customAnswers,
      multiChoices: entry?.multiChoices,
    });
    if (!message || !writeClaudeBidiMessage(proc, message)) continue;
    state.sentApprovalResponseIds.add(responseId);
    const inMemoryPending = state.pendingApprovals.get(approvalId);
    if (inMemoryPending) inMemoryPending.state = 'responded';
    clearPrivilegedBatchOpenIfResolved(state);
    state.lastControlActivityAt = Date.now();
    const formattedDecision = formatCodexAppServerApprovalDecision(decision);
    const event = {
      type: 'agentoc.approval_response',
      approvalId,
      provider: 'claude',
      decision: formattedDecision,
      status: formattedDecision === 'denied' || formattedDecision === 'cancelled' ? 'denied' : 'approved',
      providerRequestId: pending.providerRequestIdString || String(pending.providerRequestId ?? ''),
      providerMethod: pending.providerMethod || '',
      ...(entry?.privilegedBatchId ? { privilegedBatchId: entry.privilegedBatchId } : {}),
      ...(entry?.privilegedOpId ? { privilegedOpId: entry.privilegedOpId } : {}),
      ...(entry?.privilegedCategory ? { privilegedCategory: entry.privilegedCategory } : {}),
      ...(entry?.privilegedDecision ? { privilegedDecision: entry.privilegedDecision } : {}),
      ...(entry?.privilegedDecisionSource ? { privilegedDecisionSource: entry.privilegedDecisionSource } : {}),
      ...(entry?.privilegedExecutionState ? { privilegedExecutionState: entry.privilegedExecutionState } : {}),
      ...riskAuditFields(pending),
    };
    // DS-14: line was a pure duplicate of json — readers prefer `json`.
    await appendRunSpoolRecord(run.id, { ts: nowIso(), stream: 'stdout', json: event });
    await markCodexAppServerApprovalResponseSent(run.id, entry, message);
  }
}

// P1c-4 quiescence window. The provider blocks on its permission gate BEFORE the
// turn terminal (design §13.6), so the batch cannot be drained at the turn
// boundary (deadlock — the turn never ends while the gate is held). Instead,
// after each accumulated privileged gate we (re)arm this debounce; when no new
// gate arrives before it fires we treat the turn's batch as complete and surface
// it into waiting_user. Order ~hundreds of ms. Tuning against serial-vs-parallel
// provider gate emission is a P1c-4 live-exposure gate (not exercised in this
// slice — default OFF, and no test spawns a privileged run).
const PRIVILEGED_BATCH_DRAIN_MS = 400;

function armPrivilegedBatchDrain(runId, state) {
  if (!state || !isPrivilegeRoutingEnabled(state)) return;
  if (state.privilegedBatchTimer) {
    clearTimeout(state.privilegedBatchTimer);
    state.privilegedBatchTimer = null;
  }
  state.privilegedBatchTimer = setTimeout(() => {
    state.privilegedBatchTimer = null;
    // Skip if the turn is over, a batch is already open awaiting resolution, or
    // the accumulator was emptied/cancelled since the timer was armed.
    if (!isPrivilegeRoutingEnabled(state) || state.terminalSeen || state.privilegedBatchOpen) return;
    if (!Array.isArray(state.privilegedTurnOps) || state.privilegedTurnOps.length === 0) return;
    void drainPrivilegedBatch(runId, state).catch((error) => {
      console.error(`[sidecar] privileged batch drain failed for run ${runId}: ${normalizeErrorMessage(error)}`);
    });
  }, PRIVILEGED_BATCH_DRAIN_MS);
}

async function drainPrivilegedBatch(runId, state) {
  if (!state || !isPrivilegeRoutingEnabled(state) || !Array.isArray(state.privilegedTurnOps) || state.privilegedTurnOps.length === 0) {
    return;
  }
  // Snapshot + build + clear the accumulator with NO await in between, so a gate
  // arriving during the updateRun await below goes into a fresh accumulator (and
  // is drained by the next debounce cycle) instead of being dropped.
  // buildPrivilegedBatch is synchronous, so this block is atomic w.r.t. the loop.
  const ops = state.privilegedTurnOps;
  const batch = buildPrivilegedBatch({
    runId,
    turnId: state.turnId || '',
    ops,
  });
  if (!batch?.batchId) return;
  state.privilegedTurnOps = [];
  await updateRun(runId, (current) => ({
    ...current,
    privilegedBatchPending: batch,
  }));
  // P1c-5: the batch is now surfaced into the run record. The chat-server side
  // (session-manager syncDetachedRunUnlocked) will consume it, call
  // openPrivilegedBatchApproval(batch, realStore), and append the
  // privileged_batch_request event. That event's presence makes the run project
  // to waiting_user (P1c-7 extends findPendingApproval).
  // Mark the batch open so the idle-kill exemption (P1c-4) continues to cover
  // the long waiting_user pause after the accumulator is drained — the user may
  // take minutes to resolve the two popups. Cleared at resolve (P1c-6).
  state.privilegedBatchOpen = true;
}

function maybeInterruptCodexAppServerTurn(proc, state) {
  if (!state || state.interruptSent || !state.threadId || !state.turnId || state.terminalSeen) {
    return false;
  }
  const requestId = state.nextControlRequestId;
  state.nextControlRequestId += 1;
  const sent = writeCodexAppServerMessage(proc, buildCodexAppServerTurnInterruptMessage({
    id: requestId,
    threadId: state.threadId,
    turnId: state.turnId,
  }));
  if (sent) state.interruptSent = true;
  return sent;
}

async function appendCodexContextMetrics(runId, options = {}) {
  if (options.supportsExternalUsageProjection !== true) return null;
  const current = await getRun(runId);
  if (!current?.codexThreadId) return null;

  const metrics = await readLatestCodexSessionMetrics(current.codexThreadId, {
    startedAt: current.startedAt || current.createdAt || null,
    completedAt: current.completedAt || null,
  });
  const payload = buildCodexContextMetricsPayload(metrics);
  if (!payload) return null;

  // DS-14: line was a pure duplicate of json — readers prefer `json`.
  await appendRunSpoolRecord(runId, {
    ts: nowIso(),
    stream: 'stdout',
    json: payload,
  });

  await updateRun(runId, (draft) => ({
    ...draft,
    contextInputTokens: metrics.contextTokens,
    ...(Number.isInteger(metrics.contextWindowTokens)
      ? { contextWindowTokens: metrics.contextWindowTokens }
      : {}),
  }));

  return metrics;
}

async function appendCodexContextMetricsSafely(runId, options = {}) {
  try {
    if (process.env.AGENTOC_TEST_THROW_ON_FINALIZATION_METRICS === '1') {
      throw new Error('Synthetic finalization metrics failure');
    }
    return await appendCodexContextMetrics(runId, options);
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to append Codex context metrics during runner finalization', {
      error: normalizeErrorMessage(error),
    });
    return null;
  }
}

async function appendFileChangeStatsSummarySafely(runId, tracker) {
  try {
    const payload = tracker?.buildTerminalStatsPayload?.({ runId });
    if (!payload) return null;
    // DS-14: line was a pure duplicate of json — readers prefer `json`.
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      json: payload,
    });
    return payload;
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to append terminal file-change stats summary', {
      error: normalizeErrorMessage(error),
    });
    return null;
  }
}

async function adoptNativeOAuthLockForSidecar() {
  const lockPath = typeof process.env.AGENTOC_NATIVE_OAUTH_LOCK_PATH === 'string'
    ? process.env.AGENTOC_NATIVE_OAUTH_LOCK_PATH.trim()
    : '';
  const lockToken = typeof process.env.AGENTOC_NATIVE_OAUTH_LOCK_TOKEN === 'string'
    ? process.env.AGENTOC_NATIVE_OAUTH_LOCK_TOKEN.trim()
    : '';
  if (!lockPath && !lockToken) return null;
  if (!lockPath || !lockToken) {
    throw new Error('Native OAuth lock handoff is incomplete');
  }
  nativeOAuthLockHandle = await adoptNativeOAuthLock(lockPath, lockToken);
  return nativeOAuthLockHandle;
}

async function releaseNativeOAuthLock() {
  if (!nativeOAuthLockHandle) return;
  if (!nativeOAuthLockReleasePromise) {
    nativeOAuthLockReleasePromise = nativeOAuthLockHandle.release().catch((error) => {
      console.error(`[sidecar] Failed to release native OAuth lock for run ${runId}: ${normalizeErrorMessage(error)}`);
    });
  }
  await nativeOAuthLockReleasePromise;
}

async function abortSidecarFromFatal(error, label) {
  if (fatalSidecarTerminationInFlight) return;
  fatalSidecarTerminationInFlight = true;
  const details = {};
  if (typeof error?.stack === 'string' && error.stack) {
    details.stack = error.stack;
  }
  try {
    await persistRunFailure(runId, error, {
      logLabel: label,
      details,
    });
  } catch (persistError) {
    console.error(`[sidecar] Failed to persist fatal termination for run ${runId}: ${normalizeErrorMessage(persistError)}`);
  } finally {
    await releaseNativeOAuthLock();
  }
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  void abortSidecarFromFatal(reason, 'Detached runner hit an unhandled rejection');
});

process.on('uncaughtException', (error) => {
  void abortSidecarFromFatal(error, 'Detached runner crashed with an uncaught exception');
});

async function main() {
  if (!runId) process.exit(1);
  // Check the real inherited token again, including direct/recovery launches.
  const executionIdentity = await assertOrdinaryWindowsExecutionIdentity();
  // Direct starts and recovery must not adopt an OAuth lock or execute a
  // temporary task through the ordinary sidecar.
  const { run, manifest } = await assertRunLaunchBoundary(runId);
  if (isLinuxPeerResultRunner()) {
    const attempt = run.runnerLaunchAttempt ?? 0;
    if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10000) throw new Error('Invalid protected Run launch attempt');
    const { waitForProtectedLinuxRunReady } = await import('./linux-run-peer-result-client.mjs');
    await waitForProtectedLinuxRunReady({ ...linuxPeerResultClientOptions(), runId, launchAttempt: attempt });
  }
  if (process.platform === 'win32' && executionIdentity?.sid) {
    try { await bindWindowsRunExecutionIdentity(runId, executionIdentity); }
    catch (error) { console.error(`[sidecar] Windows Run identity binding unavailable: ${error?.message || 'unknown error'}`); }
  }
  await adoptNativeOAuthLockForSidecar();

  await updateRun(runId, (current) => ({
    ...current,
    state: 'running',
    startedAt: current.startedAt || nowIso(),
    runnerProcessId: process.pid,
    runnerUnitName: current?.runnerUnitName || process.env.AGENTOC_RUNNER_UNIT_NAME || null,
    runnerUnitScope: current?.runnerUnitScope || process.env.AGENTOC_RUNNER_UNIT_SCOPE || null,
    runnerLaunchMode: current?.runnerLaunchMode || process.env.AGENTOC_RUNNER_LAUNCH_MODE || null,
    ...(process.env[CODEX_FRESH_RECOVERY_ENV] === '1'
      ? {
        providerRecovery: {
          ...(current?.providerRecovery || {}),
          state: 'claimed',
          replacementProcessId: process.pid,
          claimedAt: nowIso(),
        },
      }
      : {}),
  }));
  // Runs no longer hold a WorkspaceLease (mutation-scoped lease redesign), so
  // there is no sidecar heartbeat to start.

  if (process.env.AGENTOC_TEST_RUNNER_SIDECAR_FAIL_BEFORE_TOOL_SPAWN === '1') {
    throw new Error('Synthetic sidecar failure before tool spawn');
  }

  const stagedImages = await verifyRunInputAttachments(manifest, run, runId);
  const prompt = prependAttachmentPaths(manifest.prompt || '', stagedImages);
  // The continuity checkpoint is a separate prompt used only when a persisted
  // provider thread cannot be resumed. It must receive the same Run-local
  // attachment paths as the normal prompt; otherwise stale-resume recovery
  // falls back to display names that the runner cannot open.
  const freshRecoveryPrompt = typeof manifest.freshRecoveryPrompt === 'string' && manifest.freshRecoveryPrompt
    ? prependAttachmentPaths(manifest.freshRecoveryPrompt, stagedImages)
    : prompt;
  // This environment flag is only ever emitted by the Codex app-server stale
  // resume handoff below. It is intentionally broader than the manifest tool
  // id so custom Codex-compatible app-server fixtures receive the same fresh
  // thread semantics during recovery.
  const forceFreshCodexRecovery = process.env[CODEX_FRESH_RECOVERY_ENV] === '1';
  if (manifest.options?.runtimeFamily === 'openhands-agent-server') {
    const serviceCwd = resolveRunCwd(manifest).cwd;
    const serviceOutcome = await runOpenHandsServiceSidecar({
      runId,
      manifest,
      prompt,
      cwd: serviceCwd,
      // OpenHands is a service harness, but its high-volume event stream has
      // the same durability/ordering contract as every process harness.
      // Batch raw and bridged frames through the shared spool writer; terminal
      // publication below explicitly flushes the batch first.
      append: (record) => appendRunSpoolRecord(
        runId,
        { ts: nowIso(), stream: 'stdout', json: record },
        { buffered: true },
      ),
      readRun: getRun,
      updateRun,
      serviceCommand: manifest.options?.toolCommand || 'agent-canvas',
      assertLaunchBoundary: () => assertRunLaunchBoundary(runId),
    });
    const current = await getRun(runId) || run;
    const failed = serviceOutcome?.event?.type === 'run.failed';
    const cancelled = serviceOutcome?.cancelled === true || current?.cancelRequested === true;
    const result = {
      completedAt: nowIso(),
      exitCode: cancelled || !failed ? 0 : 1,
      signal: null,
      cancelled,
      ...(failed ? { error: serviceOutcome.event.content || 'OpenHands reported an error' } : {}),
      ...(serviceOutcome?.conversationId ? { openHandsConversationId: serviceOutcome.conversationId } : {}),
    };
    await persistRunTerminalState(runId, result, cancelled ? 'cancelled' : failed ? 'failed' : 'completed', failed ? { failureReason: result.error } : {});
    await waitForApprovedActionResolution(runId);
    await releaseNativeOAuthLock();
    process.exit(cancelled || failed ? 1 : 0);
    return;
  }
  // Resolve the runner-owned Codex home before any invocation/model lookup.
  // createToolInvocation() can resolve a default model before cleanEnv() has
  // had a chance to install CODEX_HOME; passing it explicitly prevents that
  // early lookup from falling back to the user's project/home config.
  const runnerCodexHomeDir = resolveRunnerCodexHomeDir();
  const runnerAgyHomeDir = resolveRunnerAgyHomeDir();
  const runnerClaudeHomeDir = process.env.AGENTOC_PROVIDER_HOMES_DIR
    ? join(process.env.AGENTOC_PROVIDER_HOMES_DIR, 'claude')
    : '';
  const {
    command: initialCommand,
    args: initialArgs,
    input: initialInput,
    runtimeFamily,
    envOverrides,
    capabilities,
    provider,
    permissionMode,
    isClaudeFamily,
    isCodexAppServerFamily,
    isClaudeBidiFamily,
    isAgyFamily,
    isPiFamily,
    acp,
  } = await createToolInvocation(manifest.tool, forceFreshCodexRecovery ? freshRecoveryPrompt : prompt, {
    dangerouslySkipPermissions: true,
    // The runner env policy strips AGENTOC_CONFIG_DIR/HOME, so the sidecar
    // cannot re-read the control plane's tools.json for custom/test tools.
    // The control plane already resolved the tool for the run manifest; carry
    // that resolution into the invocation instead of losing it to the env
    // boundary.
    runtimeFamily: manifest.options?.runtimeFamily || undefined,
    toolCommand: manifest.options?.toolCommand || undefined,
    claudeSessionId: manifest.options?.claudeSessionId,
    codexThreadId: manifest.options?.codexThreadId,
    codexResume: manifest.options?.codexResume === true && !forceFreshCodexRecovery,
    agyConversationId: manifest.options?.agyConversationId,
    agyResume: manifest.options?.agyResume === true,
    providerResumeId: manifest.options?.providerResumeId,
    thinking: manifest.options?.thinking,
    model: manifest.options?.model,
    effort: manifest.options?.effort,
    codexHomeDir: runnerCodexHomeDir,
    claudeHomeDir: runnerClaudeHomeDir,
    interactionMode: manifest.options?.interactionMode,
    permissionMode: manifest.options?.permissionMode,
    riskMode: manifest.options?.riskMode,
    developerInstructions: manifest.developerInstructions,
    systemPrefix: manifest.systemPrefix,
    deepSeekHarnessAcp: manifest.options?.deepSeekHarnessAcp === true,
    deepSeekHarnessConfig: manifest.options?.deepSeekHarnessConfig,
    piProvider: manifest.options?.piProvider || (process.env.AGENTOC_PROVIDER_PROTOCOL === 'anthropic-messages' ? 'anthropic' : 'openai'),
  });
  const supportsExternalUsageProjection = hasProviderCapability(
    { runtimeFamily, providerCapabilities: capabilities },
    'supportsExternalUsageProjection',
  );

  await updateRun(runId, (current) => ({
    ...current,
    ...(provider ? { provider } : {}),
    ...(runtimeFamily ? { runtimeFamily } : {}),
    ...(capabilities ? { providerCapabilities: capabilities } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  }));

  const spawnEnv = await cleanEnv(manifest.tool, manifest, {
    runtimeFamily,
    envOverrides,
    codexHomeDir: runnerCodexHomeDir,
    agyHomeDir: runnerAgyHomeDir,
    acp,
  });
  const codexBrokerBasePath = spawnEnv.PATH || spawnEnv.Path || '';
  configureWindowsClaudeWorkingDirectory(spawnEnv, { bidi: isClaudeBidiFamily, riskMode: manifest.options?.riskMode });
  let args = initialArgs;

  const attachmentPaths = [];
  for (const img of stagedImages) {
    if (typeof img?.inputPath !== 'string' || !img.inputPath) continue;
    const entry = {
      path: img.inputPath,
      mimeType: typeof img?.mimeType === 'string' ? img.mimeType : '',
      originalName: typeof img?.originalName === 'string' ? img.originalName : '',
    };
    attachmentPaths.push(entry);
  }
  if (attachmentPaths.length > 0) {
    spawnEnv.AGENTOC_ATTACHMENT_PATHS = JSON.stringify(attachmentPaths);
  }

  // Real `agentoc-privileged` (design docs/privileged-shim-channel-2026-09-03.md):
  // install the per-Run launcher on the provider PATH and serve its callback
  // socket, so the privileged sentinel works even when the provider has no
  // approval gate (agy) or its sandbox auto-runs commands (Codex
  // danger-full-access) instead of failing with "command not found". Requests
  // ride the same batch → owner-approval → privileged-executor pipeline as the
  // provider-gate path. A channel failure must never break the Run; the shim
  // then fails with a self-describing channel error.
  const readOnlyRequested = manifest.executionScope?.accessMode === 'read'
    || manifest.options?.readOnlyRequired === true;
  if (readOnlyRequested) {
    for (const key of Object.keys(spawnEnv)) {
      if (key.startsWith('AGENTOC_APPROVED_ACTIONS_') || key.startsWith('AGENTOC_BROWSER_')) delete spawnEnv[key];
    }
  }
  let privilegedShimChannel = null;
  if (!readOnlyRequested) {
    try {
      privilegedShimChannel = await startPrivilegedShimChannel({
        runId,
        nodePath: process.execPath,
        commandEntryPath: join(PROJECT_ROOT, 'chat', 'privileged-shim-command.mjs'),
        log: async (message, details) => logSidecarDiagnostic(runId, message, details),
      });
      applyPrivilegedShimSpawnEnv(spawnEnv, privilegedShimChannel);
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Privileged shim channel unavailable; sentinel commands will report a channel error', {
        error: normalizeErrorMessage(error),
      });
    }
  }
  if (process.platform === 'win32') {
    try {
      await installWindowsRunCliShim(spawnEnv, {
        runDirectory: runDir(runId), nodePath: process.execPath, entryPath: join(PROJECT_ROOT, 'cli.js'),
      });
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Run CLI launcher unavailable; use the documented Node fallback', {
        error: normalizeErrorMessage(error),
      });
    }
  }
  // 'exit' handlers must be synchronous: stop the accept loop implicitly by
  // process teardown and remove the socket/bin links so no stale listener path
  // survives the Run.
  process.once('exit', () => {
    try {
      rmSync(privilegedShimChannel?.socketPath || '', { force: true });
    } catch {}
  });

  let resolvedFolder = resolveRunCwd(manifest);
  if (resolvedFolder.repaired) {
    await logSidecarDiagnostic(runId, 'Repaired stale session folder before tool launch', {
      requestedCwd: resolvedFolder.requestedCwd,
      cwd: resolvedFolder.cwd,
      reason: resolvedFolder.reason,
    });
  }
  if (isClaudeFamily && manifest.options?.claudeSessionId) {
    const resumeCwd = await resolveClaudeResumeCwd({
      requestedCwd: resolvedFolder.cwd,
      claudeSessionId: manifest.options.claudeSessionId,
      claudeHomeDir: spawnEnv.CLAUDE_CONFIG_DIR,
    });
    if (resumeCwd.relocated) {
      await logSidecarDiagnostic(runId, 'Relocated Claude resume cwd from transcript', {
        requestedCwd: resumeCwd.requestedCwd,
        cwd: resumeCwd.cwd,
        reason: resumeCwd.reason,
        transcriptPath: resumeCwd.transcriptPath,
      });
      resolvedFolder = {
        ...resolvedFolder,
        cwd: resumeCwd.cwd,
        repaired: true,
        reason: resumeCwd.reason,
      };
    }
  }

  const fileChangeStatsTracker = createFileChangeStatsTracker({
    cwd: resolvedFolder.cwd,
    baselineRoots: [resolvedFolder.cwd, PROJECT_ROOT],
    // A read-only run cannot change the project; scanning the entire source
    // tree here adds substantial startup latency without a useful baseline.
    captureRunBaseline: !readOnlyRequested,
  });
  const appServerManifest = isCodexAppServerFamily && permissionMode
    ? { ...manifest, options: { ...(manifest.options || {}), permissionMode } }
    : manifest;
  const appServerState = isCodexAppServerFamily
    ? await createCodexAppServerRunState({
      prompt,
      freshRecoveryPrompt,
      manifest: appServerManifest,
      cwd: resolvedFolder.cwd,
      codexHomeDir: runnerCodexHomeDir,
      forceFreshRecovery: forceFreshCodexRecovery,
    })
    : null;
  if (appServerState?.agentocApprovalGate) {
    // Direct process launches still need this override. The shared broker
    // uses the equivalent thread-scoped trust configuration instead.
    args = [...args, ...buildCodexAppServerProjectTrustArgs(resolvedFolder.cwd)];
  }
  if (appServerState && manifest.tool === 'codex') {
    await validateCodexProviderHome(runnerCodexHomeDir);
  }
  const claudeBidiState = isClaudeBidiFamily
    ? createClaudeBidiRunState({
      prompt,
      manifest,
      cwd: resolvedFolder.cwd,
    })
    : null;
  if (claudeBidiState) {
    // The scoped CLI bridge must not replace a command unless this child
    // actually has a complete capability for its own run and session.
    claudeBidiState.sessionControlReadAvailable = Boolean(spawnEnv.AGENTOC_SESSION_CONTROL_TOKEN &&
      spawnEnv.AGENTOC_SESSION_CONTROL_RUN_ID === runId &&
      spawnEnv.AGENTOC_SESSION_CONTROL_SESSION_ID === manifest.sessionId &&
      spawnEnv.AGENTOC_SESSION_ID === manifest.sessionId && spawnEnv.AGENTOC_SESSION_CONTROL_TURN_ID);
    claudeBidiState.sessionControlReadRunId = claudeBidiState.sessionControlReadAvailable ? runId : '';
  }
  if (appServerState) {
    appServerState.sessionControlReadAvailable = Boolean(spawnEnv.AGENTOC_SESSION_CONTROL_TOKEN &&
      spawnEnv.AGENTOC_SESSION_CONTROL_RUN_ID === runId &&
      spawnEnv.AGENTOC_SESSION_CONTROL_SESSION_ID === manifest.sessionId &&
      spawnEnv.AGENTOC_SESSION_ID === manifest.sessionId && spawnEnv.AGENTOC_SESSION_CONTROL_TURN_ID);
    appServerState.sessionControlReadRunId = appServerState.sessionControlReadAvailable ? runId : '';
  }
  // —— 2026-08-06 防污染兜底：codex run 启动前把 managed home 镜像到 DB current 行 ——
  // 切换可走平台端点或 cc-switch 自身，两者都可能不同步 managed home；
  // 官方形态下顺带停掉代理 daemon，杜绝按陈旧 backup 转发 401。
  // 2026-08-08 补 claude 对偶：claude-bidi run 启动前对齐 managed claude
  // settings.json 到 DB current claude 行（含空值守卫，防 null 传播）。
  // 2026-08-08 路线 B：官方 OAuth 行先做账号健康轮换（401/429 → 刷新 →
  // 仍死切池内下一个活账号），随后 sync 把健康 current 镜像出去。
  if (isAgyFamily) {
    const providerHome = runnerAgyHomeDir || '';
    const marker = providerHome
      ? (await readFile(join(providerHome, '.agentoc-provider-id'), 'utf8').catch(() => '')).trim()
      : '';
    const targetProviderId = String(
      process.env.AGENTOC_PROVIDER_PROFILE_ID
        || manifest.options?.providerProfile
        || '',
    ).trim();
    if (!marker || (targetProviderId && marker !== targetProviderId)) {
      throw new Error(`AgY provider home is not prepared for selected provider ${targetProviderId || '(rotation)'}`);
    }
    await updateRun(runId, (current) => ({
      ...current,
      providerProfile: marker,
      agyProviderProfileId: marker,
      resolvedProviderId: marker,
      providerSync: { ok: true, providerId: marker, preparedBy: 'runner-launcher' },
    }));
  } else if (isCodexAppServerFamily) {
    // —— 2026-08-09 按所选模型注入凭据 ——
    // 会话选了非 current 提供方模型（scoped id 带 providerId）→ 镜像该
    // provider 行（config+auth）到 managed home；无后缀（默认/历史会话）
    // → current（原行为，防污染兜底语义不变）。
    const targetProviderId = appServerState?.providerId || '';
    const providerHome = process.env.AGENTOC_PROVIDER_HOMES_DIR
      ? join(process.env.AGENTOC_PROVIDER_HOMES_DIR, 'codex')
      : '';
    const marker = providerHome ? (await readFile(join(providerHome, '.agentoc-provider-id'), 'utf8').catch(() => '')).trim() : '';
    if (targetProviderId && marker !== targetProviderId) {
      const binding = providerHome ? await readJsonIfPresent(codexRunBindingPath(providerHome, runId), readFile) : null;
      const auth = providerHome ? await readJsonIfPresent(join(providerHome, 'auth.json'), readFile) : null;
      if (!verifyCodexRunBinding(binding, { runId, providerId: targetProviderId, accountId: codexRolloutAccountId(auth) })) {
        throw new Error('Codex provider home is not prepared for selected provider ' + targetProviderId);
      }
    }
    await updateRun(runId, (current) => ({ ...current, resolvedProviderId: targetProviderId || marker || '', resolvedProviderModel: appServerState.model, providerSync: { ok: true, providerId: targetProviderId || marker || '', configuredModel: appServerState.model, preparedBy: 'runner-lifecycle' } }));
  } else if (isClaudeBidiFamily) {
    const targetProviderId = typeof manifest.options?.providerProfile === 'string'
      ? manifest.options.providerProfile.trim()
      : '';
    const providerHome = process.env.AGENTOC_PROVIDER_HOMES_DIR
      ? join(process.env.AGENTOC_PROVIDER_HOMES_DIR, 'claude')
      : '';
    const marker = providerHome ? (await readFile(join(providerHome, '.agentoc-provider-id'), 'utf8').catch(() => '')).trim() : '';
    if (targetProviderId && marker !== targetProviderId) {
      throw new Error(`Claude provider home is not prepared for selected provider ${targetProviderId}`);
    }
    await updateRun(runId, (current) => ({
      ...current,
      resolvedProviderId: marker || targetProviderId || '',
      providerSync: {
        ok: true,
        providerId: marker || targetProviderId || '',
        preparedBy: 'runner-launcher',
      },
    }));
  }
  const approvedActionChannel = manifest.options?.approvedActionChannel;
  const managedActionMcpRequested = !readOnlyRequested && Boolean(
    approvedActionChannel?.token && approvedActionChannel?.endpoint,
  );
  const windowsElevationHook = shouldInstallWindowsElevationHook({ platform: process.platform, runtimeFamily,
    interactionMode: manifest.options?.interactionMode, permissionMode: manifest.options?.permissionMode,
    workbenchPolicy: WORKBENCH_EXECUTION_POLICY });
  const runtimeAuth = isCodexAppServerFamily && runnerCodexHomeDir
    ? await readJsonIfPresent(join(runnerCodexHomeDir, 'auth.json'), readFile)
    : null;
  const codexOAuthRuntime = Boolean(runtimeAuth?.tokens && typeof runtimeAuth.tokens === 'object');
  const sharedReadOnlyCodex = Boolean(process.platform === 'linux' && appServerState && codexOAuthRuntime
    && readOnlyRequested && !WORKBENCH_EXECUTION_POLICY);
  const sharedCodexThreadSupported = Boolean(appServerState && codexOAuthRuntime
    && (!readOnlyRequested || sharedReadOnlyCodex) && !WORKBENCH_EXECUTION_POLICY);
  const threadScopedCodexMcp = sharedCodexThreadSupported;
  const windowsBrokerChannel = manifest.options?.windowsBrokerChannel;
  const windowsBrokerMcpRequested = !readOnlyRequested && Boolean(
    windowsBrokerChannel?.token && windowsBrokerChannel?.endpoint,
  );
  // The control-plane feature flag is process-global, but the worker tool is
  // run-scoped. Strip the inherited flag before projecting the manifest grant.
  delete spawnEnv.AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED;
  delete spawnEnv.AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT;
  delete spawnEnv.AGENTOC_WINDOWS_INSTALL_BRIDGE_DISABLED;
  if (windowsElevationHook && !['recommended', 'full-auto'].includes(manifest.options?.riskMode)) {
    spawnEnv.AGENTOC_WINDOWS_INSTALL_BRIDGE_DISABLED = '1';
  }
  if (process.platform === 'win32' && appServerState && !WORKBENCH_EXECUTION_POLICY && appServerState.riskContextValid === true &&
      ['recommended', 'full-auto'].includes(appServerState.riskMode) && appServerState.interactionMode !== 'plan' && appServerState.permissionMode !== 'plan') {
    spawnEnv.AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT = JSON.stringify({ runId, helperPath: join(PROJECT_ROOT, 'bin', 'agentoc-safe-delete.exe'),
      assetHelperPath: join(PROJECT_ROOT, 'bin', 'agentoc-cli-read-bridge.exe'), searchHelperPath: join(PROJECT_ROOT, 'bin', 'agentoc-safe-search.exe'), port: Number(CHAT_PORT), state: { riskMode: appServerState.riskMode, riskContextValid: true,
      sessionControlReadAvailable: appServerState.sessionControlReadAvailable, sessionControlReadRunId: appServerState.sessionControlReadRunId,
      interactionMode: appServerState.interactionMode, permissionMode: appServerState.permissionMode,
      riskContext: { platform: 'win32', trustedWorkspaceRoot: appServerState.riskContext.trustedWorkspaceRoot,
        programDataRoot: appServerState.riskContext.programDataRoot || '',
        protectedRoots: appServerState.riskContext.protectedRoots, systemPathRoots: appServerState.riskContext.systemPathRoots || [] } } });
  }
  const browserChannel = manifest.options?.browserChannel;
  const browserMcpRequested = !readOnlyRequested && Boolean(
    spawnEnv.AGENTOC_BROWSER_MCP_ENABLED === '1'
    && spawnEnv.AGENTOC_BROWSER_TOKEN
    && supportsBrowserMcpRuntime(runtimeFamily, { acp: acp === true })
    && browserChannel?.enabled === true
    && browserChannel?.endpoint,
  );
  let managedMcpOverlay = null;
  let acpMcpServers = [];
  if (managedActionMcpRequested) {
    spawnEnv.AGENTOC_APPROVED_ACTIONS_ENABLED = '1';
    spawnEnv.AGENTOC_APPROVED_ACTIONS_ENDPOINT = approvedActionChannel.endpoint;
    spawnEnv.AGENTOC_APPROVED_ACTIONS_TOKEN = approvedActionChannel.token;
    spawnEnv.AGENTOC_APPROVED_ACTIONS_SESSION_ID = manifest.sessionId || '';
    spawnEnv.AGENTOC_APPROVED_ACTIONS_RUN_ID = runId;
    spawnEnv.AGENTOC_APPROVED_ACTIONS_TURN_ID = approvedActionChannel.turnId || manifest.requestId || runId;
    if (approvedActionChannel.windowsUserInstallIdentity) {
      spawnEnv.AGENTOC_WINDOWS_USER_INSTALL_IDENTITY = JSON.stringify(approvedActionChannel.windowsUserInstallIdentity);
    }
    spawnEnv.AGENTOC_APPROVED_ACTIONS_CWD = resolvedFolder.cwd;
    spawnEnv.AGENTOC_APPROVED_ACTIONS_PROJECT_ROOT = manifest.options?.projectRoot || resolvedFolder.cwd;
    // The agent-create grant must be decided before overlay preparation: the
    // codex overlay snapshots these bindings into its config.toml env table
    // (codex MCP children do not inherit the process env), so setting the
    // flag after prepare would never reach the script.
    if (approvedActionChannel.productAgentCreate === true) {
      spawnEnv.AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED = '1';
    }
  }

  if (windowsBrokerMcpRequested) {
    spawnEnv.AGENTOC_WINDOWS_BROKER_ENDPOINT = windowsBrokerChannel.endpoint;
    spawnEnv.AGENTOC_WINDOWS_BROKER_TOKEN = windowsBrokerChannel.token;
    spawnEnv.AGENTOC_WINDOWS_BROKER_SESSION_ID = manifest.sessionId || '';
    spawnEnv.AGENTOC_WINDOWS_BROKER_RUN_ID = runId;
    spawnEnv.AGENTOC_WINDOWS_BROKER_TURN_ID = windowsBrokerChannel.turnId || manifest.requestId || runId;
  }

  if (managedActionMcpRequested || windowsBrokerMcpRequested || (browserMcpRequested && acp !== true)) {
    const preparingMcp = {
      state: 'preparing',
      stage: 'preflight',
      attempt: 1,
      maxAttempts: MCP_OVERLAY_MAX_ATTEMPTS,
      startedAt: nowIso(),
    };
    await updateRun(runId, (current) => ({
      ...current,
      mcpPreparation: preparingMcp,
      ...(managedActionMcpRequested
        ? {
          approvedActionCapability: {
            ...(current?.approvedActionCapability || {}),
            state: 'preparing',
            reason: null,
            preparation: preparingMcp,
          },
        }
        : {}),
    })).catch(() => null);
    try {
      const managedMcpServers = [];
      if (managedActionMcpRequested) {
        managedMcpServers.push({
          // Keep the established server name stable for Codex/Claude readiness
          // and existing provider fixtures; browser gets its own namespace.
          kind: 'actions',
          scriptPath: join(PROJECT_ROOT, 'scripts', 'agentoc-approved-actions-mcp.mjs'),
          envKeys: [
            'AGENTOC_APPROVED_ACTIONS_ENABLED',
            'AGENTOC_APPROVED_ACTIONS_ENDPOINT',
            'AGENTOC_APPROVED_ACTIONS_TOKEN',
            'AGENTOC_APPROVED_ACTIONS_SESSION_ID',
            'AGENTOC_APPROVED_ACTIONS_RUN_ID',
            'AGENTOC_APPROVED_ACTIONS_TURN_ID',
            'AGENTOC_APPROVED_ACTIONS_CWD',
            'AGENTOC_APPROVED_ACTIONS_PROJECT_ROOT',
            'AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED',
          ],
        });
      }
      if (windowsBrokerMcpRequested) {
        managedMcpServers.push({
          kind: 'broker',
          scriptPath: join(PROJECT_ROOT, 'scripts', 'agentoc-windows-broker-mcp.mjs'),
          envKeys: [
            'AGENTOC_WINDOWS_BROKER_ENDPOINT',
            'AGENTOC_WINDOWS_BROKER_TOKEN',
            'AGENTOC_WINDOWS_BROKER_SESSION_ID',
            'AGENTOC_WINDOWS_BROKER_RUN_ID',
            'AGENTOC_WINDOWS_BROKER_TURN_ID',
          ],
        });
      }
      if (browserMcpRequested) {
        managedMcpServers.push({
          kind: 'browser',
          scriptPath: join(PROJECT_ROOT, 'scripts', 'agentoc-browser-mcp-server.mjs'),
          envKeys: BROWSER_MCP_ENV_KEYS,
        });
      }
      managedMcpOverlay = threadScopedCodexMcp
        ? await prepareCodexThreadMcp({ runId, spawnEnv, servers: managedMcpServers })
        : await prepareManagedMcpOverlay({
        runtimeFamily,
        runId,
        spawnEnv,
        servers: managedMcpServers,
        codexWindowsApprovalGate: process.platform === 'win32' && runtimeFamily === 'codex-app-server-json'
          && ['safe', 'recommended', 'full-auto'].includes(manifest.options?.riskMode),
        codexWindowsInstallHook: windowsElevationHook
          ? join(PROJECT_ROOT, 'scripts', 'agentoc-codex-windows-install-hook.mjs') : '',
      });
      if (threadScopedCodexMcp && managedMcpOverlay) appServerState.threadMcpConfig = managedMcpOverlay.config;

      if (managedMcpOverlay) {
        const readyPreparation = readyMcpOverlayPreparation(managedMcpOverlay);
        await updateRun(runId, (current) => ({
          ...current,
          mcpPreparation: readyPreparation,
          ...(managedActionMcpRequested
            ? {
              approvedActionCapability: {
                ...(current?.approvedActionCapability || {}),
                state: 'ready',
                reason: null,
                preparation: readyPreparation,
              },
            }
            : {}),
        })).catch(() => null);
      }

      if (managedMcpOverlay?.env) Object.assign(spawnEnv, managedMcpOverlay.env);
      if (Array.isArray(managedMcpOverlay?.args)) {
        args = [...args, ...managedMcpOverlay.args];
      }
      const runtimeState = appServerState || claudeBidiState;
      if (appServerState && managedMcpOverlay?.codexWindowsInstallHook) appServerState.codexWindowsInstallHook = managedMcpOverlay.codexWindowsInstallHook;
      if (runtimeState && managedMcpOverlay?.serverNames?.length) {
        const serverNamesByKind = new Map(
          managedMcpServers.map((server, index) => [server.kind, managedMcpOverlay.serverNames[index]]),
        );
        const requiredServers = [];
        if (managedActionMcpRequested) {
          const requiredToolNames = ['ragent_request_actions'];
          if (approvedActionChannel.productAgentCreate === true) requiredToolNames.push('ragent_create_agent');
          requiredServers.push({
            name: serverNamesByKind.get('actions'),
            requiredToolNames,
          });
        }
        if (windowsBrokerMcpRequested) {
          requiredServers.push({
            name: serverNamesByKind.get('broker'),
            requiredToolNames: ['ragent_restart_qa_service', 'ragent_restart_qa_service_status'],
          });
        }
        if (browserMcpRequested) {
          requiredServers.push({
            name: serverNamesByKind.get('browser'),
            requiredToolNames: ['ragent_browser_navigate'],
          });
        }
        runtimeState.mcpRequired = true;
        if (process.platform === 'win32' && managedActionMcpRequested) {
          runtimeState.windowsManagedActionChannel = true;
          runtimeState.windowsManagedActionBinding = { endpoint: approvedActionChannel.endpoint, token: approvedActionChannel.token,
            sessionId: manifest.sessionId || '', runId, turnId: approvedActionChannel.turnId || manifest.requestId || runId,
            ...(approvedActionChannel.windowsUserInstallIdentity ? { windowsUserInstallIdentity: approvedActionChannel.windowsUserInstallIdentity } : {}) };
        }
        runtimeState.mcpRequiredServers = requiredServers;
        runtimeState.mcpAutoApproveServerNames = new Set(
          requiredServers.filter((server) =>
            server.name === serverNamesByKind.get('actions')
            || server.name === serverNamesByKind.get('broker')).map((server) => server.name),
        );
        runtimeState.mcpExpectedServerName = requiredServers[0]?.name || '';
        // Keep the legacy fields populated for older helper paths and fixtures.
        runtimeState.mcpRequiredToolNames = requiredServers[0]?.requiredToolNames?.slice() || [];
      }

      if (!managedMcpOverlay) {
        delete spawnEnv.AGENTOC_APPROVED_ACTIONS_ENABLED;
        delete spawnEnv.AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED;
        const error = new Error('MCP readiness failed: MCP_OVERLAY_UNAVAILABLE');
        error.code = MCP_OVERLAY_LEGACY_ERROR_CODE;
        throw error;
      }
    } catch (error) {
      delete spawnEnv.AGENTOC_APPROVED_ACTIONS_ENABLED;
      delete spawnEnv.AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED;
      await managedMcpOverlay?.cleanup?.();
      const preparation = normalizeMcpOverlayPreparation(error);
      await logSidecarDiagnostic(runId, 'Approved action MCP overlay unavailable', {
        error: normalizeErrorMessage(error),
        errorCode: preparation.errorCode,
        ...(preparation.causeCode ? { causeCode: preparation.causeCode } : {}),
        stage: preparation.stage,
        attempt: preparation.attempt,
        maxAttempts: preparation.maxAttempts,
        runtimeFamily,
      });
      await updateRun(runId, (current) => ({
        ...current,
        mcpPreparation: preparation,
        ...(managedActionMcpRequested
          ? {
            approvedActionCapability: {
              ...(current?.approvedActionCapability || {}),
              state: 'unavailable',
              reason: 'runtime_overlay_failed',
              errorCode: preparation.errorCode,
              ...(preparation.causeCode ? { causeCode: preparation.causeCode } : {}),
              preparation,
            },
          }
          : {}),
      }));
      const overlayError = new Error(
        `MCP readiness failed: ${preparation.errorCode} (${MCP_OVERLAY_LEGACY_ERROR_CODE})`,
      );
      overlayError.code = preparation.errorCode;
      overlayError.stage = preparation.stage;
      overlayError.attempt = preparation.attempt;
      overlayError.maxAttempts = preparation.maxAttempts;
      overlayError.causeCode = preparation.causeCode || '';
      overlayError.mcpPreparation = preparation;
      throw overlayError;
    }
  }
  // The private hook also supplies elevation guidance when no managed MCP
  // channel exists. It does not add approval rules in other permission modes.
  if (!managedMcpOverlay && appServerState && windowsElevationHook && !sharedCodexThreadSupported) {
    try {
      managedMcpOverlay = await prepareManagedMcpOverlay({ runtimeFamily, runId, spawnEnv, servers: [], codexWindowsApprovalGate: Boolean(spawnEnv.AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT),
        codexWindowsInstallHook: join(PROJECT_ROOT, 'scripts', 'agentoc-codex-windows-install-hook.mjs') });
      if (managedMcpOverlay?.codexWindowsInstallHook) {
        Object.assign(spawnEnv, managedMcpOverlay.env);
        appServerState.codexWindowsInstallHook = managedMcpOverlay.codexWindowsInstallHook;
      } else { await managedMcpOverlay?.cleanup?.(); managedMcpOverlay = null; }
    } catch (error) {
      await managedMcpOverlay?.cleanup?.(); managedMcpOverlay = null;
      await logSidecarDiagnostic(runId, 'Optional Windows command hook unavailable', { error: normalizeErrorMessage(error) });
    }
  }
  if (browserMcpRequested && acp === true) {
    const browserEnv = Object.fromEntries(
      BROWSER_MCP_ENV_KEYS
        .filter((key) => typeof spawnEnv[key] === 'string' && spawnEnv[key].length > 0)
        .map((key) => [key, spawnEnv[key]]),
    );
    acpMcpServers = [{
      name: 'ragent-browser',
      command: process.execPath,
      args: [join(PROJECT_ROOT, 'scripts', 'agentoc-browser-mcp-server.mjs')],
      env: browserEnv,
    }];
  }
  // An explicitly requested sandbox is a requirement, not a best-effort
  // preference. Consult only the trusted sidecar environment and never launch
  // a provider unsandboxed if the platform or sandbox setup cannot support it.
  const readOnlyWorkspace = readOnlyWorkspaceForRun(manifest, resolvedFolder.cwd);
  const sandboxRequired = requireSandboxAvailability({ required: Boolean(readOnlyWorkspace) });
  const sharedSandboxCodex = Boolean(process.platform === 'linux' && sandboxRequired
    && appServerState && codexOAuthRuntime && !WORKBENCH_EXECUTION_POLICY);
  let resolvedCommand = await resolveCommandSpawnSpec(initialCommand, args, {
    cwd: resolvedFolder.cwd,
    env: spawnEnv,
  });
  if (isAgyFamily || isAgyRuntime({ toolId: manifest.tool, runtimeFamily })) {
    // The launcher owns the private Linux D-Bus/keyring session.  It is kept
    // outside the provider CLI so the same boundary also covers custom AgY
    // command paths and wrapper scripts.
    resolvedCommand = buildAgyRuntimeLaunchSpec({
      command: resolvedCommand.file,
      args: resolvedCommand.args,
      env: spawnEnv,
      cwd: resolvedFolder.cwd,
      nodePath: process.execPath,
    });
  }
  let spawnCommand = resolvedCommand.file;
  let spawnArgs = resolvedCommand.args;
  let spawnShell = resolvedCommand.shell;
  let spawnWindowsVerbatimArguments = resolvedCommand.windowsVerbatimArguments;

  // A normal OAuth Run uses one machine-local Codex app-server per provider
  // home. Each Run still gets a private stdio proxy and a private thread, but
  // only the broker process can observe/refresh auth.json. This removes the
  // refresh-token race without forbidding same-account concurrency.
  const runSpecificCodexMcp = isCodexAppServerFamily
    && ((Boolean(managedMcpOverlay) && !threadScopedCodexMcp)
      || (appServerState?.agentocApprovalGate === true && !sharedCodexThreadSupported));
  let sharedSandboxHidePaths = null;
  if (sharedSandboxCodex) {
    const homePath = await realpath(runnerCodexHomeDir);
    const boundary = homePath.lastIndexOf('/by-provider/');
    // An old per-Run home may contain a copied rotating credential. Never
    // start a broker for it: wait until preparation supplies the account home.
    if (boundary <= 0 || homePath.slice(boundary).includes('/by-run/')) {
      throw Object.assign(new Error('The Codex account home is not prepared for shared sandbox execution'),
        { code: 'CODEX_READONLY_ENVIRONMENT_UNAVAILABLE' });
    }
    sharedSandboxHidePaths = [homePath.slice(0, boundary)];
    for (const candidate of ['/var/lib/agentoc/config', '/etc/agentoc']) {
      if (await lstat(candidate).then(() => true, () => false)) sharedSandboxHidePaths.push(candidate);
    }
  }
  let codexAppServerBrokered = false;
  if (isCodexAppServerFamily && codexOAuthRuntime && !runSpecificCodexMcp
      && (!sandboxRequired || sharedSandboxCodex)) {
    const expectedAccountDigest = codexBrokerAccountDigest(codexRolloutAccountId(runtimeAuth));
    if (!expectedAccountDigest) {
      throw Object.assign(new Error('A verified Codex account identity is required'), { code: 'CODEX_ACCOUNT_UNVERIFIED' });
    }
    const brokerSocketPath = codexAppServerBrokerSocketPath(runnerCodexHomeDir);
    try {
      const sharedHook = process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY
        ? buildSharedCodexWindowsHook({ socketPath: brokerSocketPath }) : null;
      const brokerCommand = appServerState?.agentocApprovalGate || sharedHook
        ? await resolveCommandSpawnSpec(initialCommand, [...initialArgs, ...(sharedHook?.args || [])], { cwd: resolvedFolder.cwd, env: spawnEnv })
        : resolvedCommand;
      await ensureCodexAppServerBroker({
        socketPath: brokerSocketPath,
        lockPath: codexAppServerBrokerLockPath(runnerCodexHomeDir),
        upstreamFile: brokerCommand.file,
        upstreamArgs: brokerCommand.args,
        upstreamWindowsVerbatimArguments: brokerCommand.windowsVerbatimArguments === true,
        cwd: resolvedFolder.cwd,
        env: { ...spawnEnv, CODEX_HOME: runnerCodexHomeDir, AGENTOC_CODEX_BROKER_BASE_PATH: codexBrokerBasePath,
          AGENTOC_CODEX_BROKER_SERVICE_MODE: process.platform === 'win32' && process.env.AGENTOC_RUNNER_LAUNCH_MODE === 'runner-supervisor' ? '1' : '0' },
        scriptPath: CODEX_APP_SERVER_BROKER_SCRIPT,
        assertLaunchBoundary: () => assertRunLaunchBoundary(runId),
      });
      spawnCommand = process.execPath;
      spawnArgs = [
        join(PROJECT_ROOT, 'chat', 'codex-app-server-proxy.mjs'),
        '--socket',
        brokerSocketPath,
      ];
      spawnArgs.push('--account-digest', expectedAccountDigest);
      spawnShell = false;
      spawnWindowsVerbatimArguments = false;
      codexAppServerBrokered = true;
      if (!WORKBENCH_EXECUTION_POLICY) appServerState.threadShellEnvironment = buildCodexRunShellEnvironment(spawnEnv);
      if (sharedHook) appServerState.codexWindowsInstallHook = { ...sharedHook, configPath: join(runnerCodexHomeDir, 'config.toml') };
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Machine-local Codex app-server broker unavailable', {
        error: normalizeErrorMessage(error),
        code: error?.code || 'CODEX_APP_SERVER_BROKER_UNAVAILABLE',
      });
      // A second authenticated Codex process can race the existing broker's
      // rotating OAuth credentials even when its socket is temporarily down.
      // Surface the failure instead of silently launching that process.
      throw error;
    }
  }

  if (isCodexAppServerFamily && WORKBENCH_EXECUTION_POLICY?.codexPermissionProfile && !codexAppServerBrokered) {
    throw Object.assign(new Error('This managed-permissions workbench requires the shared Codex broker'), {
      code: 'WORKBENCH_CODEX_BROKER_REQUIRED',
    });
  }

  // The remaining exclusive path is a per-Run MCP/sandbox invocation.
  // It is a narrow safety fallback, not the normal
  // same-account execution policy.
  if (isCodexAppServerFamily && codexOAuthRuntime && !codexAppServerBrokered
      && !nativeOAuthLockHandle) {
    nativeOAuthLockHandle = await acquireNativeOAuthLock(
      join(dirname(runnerCodexHomeDir), '.agentoc-native-oauth.lock'),
    );
  }
  if (isCodexAppServerFamily && codexOAuthRuntime && !codexAppServerBrokered) {
    await assertCodexHomeNotFenced(dirname(runnerCodexHomeDir));
  }
  let readOnlyCodexExecutor = null;
  let readOnlyCodexHidePaths = null;
  if (sharedSandboxCodex) {
    if (!codexAppServerBrokered || (readOnlyRequested && !readOnlyWorkspace) || resolvedCommand.shell
        || !isAbsolute(resolvedCommand.file)) {
      throw Object.assign(new Error('A shared, isolated Codex executor is required'), { code: 'CODEX_READONLY_ENVIRONMENT_UNAVAILABLE' });
    }
    readOnlyCodexHidePaths = sharedSandboxHidePaths;
    await assertRunLaunchBoundary(runId);
    readOnlyCodexExecutor = await startReadOnlyCodexExecutor({ command: resolvedCommand.file,
      cwd: resolvedFolder.cwd, workspace: readOnlyWorkspace || resolvedFolder.cwd, readOnly: Boolean(readOnlyWorkspace),
      hidePaths: readOnlyCodexHidePaths, env: spawnEnv });
  }
  let sandboxEmptyDir = null;
  const providerSpawnEnv = isCodexAppServerFamily && !codexAppServerBrokered
    ? buildWorkbenchCodexEnvironment(spawnEnv)
    : spawnEnv;
  // The persistent broker owns the real Codex process. Wrapping only the
  // proxy here would not sandbox that owner, while wrapping the direct
  // command would bypass the broker and reintroduce duplicate refresh-token
  // writers. Brokered Codex runs therefore keep the broker boundary intact;
  // the non-brokered MCP/sandbox path retains its existing sandbox behavior.
  const wrapRequiredSandbox = (command, commandArgs, environment) => {
    let providerSeeds = null;
    try {
      const guiEnvironment = readOnlyWorkspace ? {} : pickRunnerGuiEnvironment(environment);
      if (readOnlyWorkspace) {
        providerSeeds = openReadOnlyProviderSeeds({
          family: (isCodexAppServerFamily || runtimeFamily === 'codex-json') ? 'codex' : isClaudeFamily ? 'claude' : '',
          env: environment,
          runId,
        });
      }
      const sandbox = buildSandboxedSpawn({
        command,
        args: commandArgs,
        cwd: resolvedFolder.cwd,
        runnerHome: process.env.HOME,
        readOnly: Boolean(readOnlyWorkspace),
        hidePaths: ['/var/lib/agentoc/config', '/etc/agentoc'],
        bindReadOnlyPaths: [
          ...buildRunnerGuiBindPaths(guiEnvironment),
          ...(privilegedShimChannel?.socketBindDir ? [privilegedShimChannel.socketBindDir] : []),
          ...(readOnlyWorkspace ? [readOnlyWorkspace] : []),
        ],
        exposeHostDevices: Boolean(guiEnvironment.DISPLAY),
        readOnlyProviderSeeds: providerSeeds?.seeds || [],
        readOnlyProviderFamily: providerSeeds?.family || '',
      });
      return { ...sandbox, providerSeeds };
    } catch (error) {
      closeReadOnlyProviderSeeds(providerSeeds);
      throw Object.assign(new Error(`Runner sandbox setup failed; refusing an unsandboxed run: ${normalizeErrorMessage(error)}`), {
        code: 'RUNNER_SANDBOX_SETUP_FAILED',
        cause: error,
      });
    }
  };
  let sandboxProviderSeeds = null;
  if (sandboxRequired && !codexAppServerBrokered) {
    const sandbox = wrapRequiredSandbox(resolvedCommand.file, resolvedCommand.args, spawnEnv);
    spawnCommand = sandbox.command;
    spawnArgs = sandbox.args;
    spawnShell = false;
    spawnWindowsVerbatimArguments = false;
    sandboxEmptyDir = sandbox.emptyDir;
    sandboxProviderSeeds = sandbox.providerSeeds;
  }
  const managedStdin = isClaudeFamily || isCodexAppServerFamily || isAgyFamily || isPiFamily || acp === true;
  let windowsJob;
  let proc;
  let providerStdoutStream;
  let providerStderrStream;
  let earlyStdoutError = null;
  let earlyStderrError = null;
  let pendingProcessEvent = null;
  let dispatchProcessEvent = null;
  const captureProcessEvent = (type, ...args) => {
    if (dispatchProcessEvent) dispatchProcessEvent(type, args);
    else if (!pendingProcessEvent) pendingProcessEvent = { type, args };
  };
  let providerSeedsDelivered = false;
  try {
    windowsJob = assertWindowsManagedJob(await createWindowsJobObject());
    if (windowsJob) {
      if (spawnShell === true) {
        await windowsJob.close();
        throw new Error('Windows managed provider spawn refuses shell:true');
      }
      try {
        await assertRunLaunchBoundary(runId);
        proc = await windowsJob.createProcess({
          file: spawnCommand,
          args: spawnArgs,
          cwd: resolvedFolder.cwd,
          env: providerSpawnEnv,
          windowsVerbatimArguments: spawnWindowsVerbatimArguments === true,
          stdin: managedStdin,
          stdout: true,
          stderr: true,
        });
      } catch (error) {
        try { await windowsJob.terminate(0xC0DE); } catch {}
        await windowsJob.close();
        throw error;
      }
    } else {
      await assertRunLaunchBoundary(runId);
      proc = spawn(spawnCommand, spawnArgs, {
        cwd: resolvedFolder.cwd,
        stdio: [managedStdin ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(sandboxProviderSeeds?.seeds || []).map(() => 'pipe')],
        env: providerSpawnEnv,
        shell: spawnShell,
        windowsVerbatimArguments: spawnWindowsVerbatimArguments,
        // Generic routers (micro-agent, connector helpers, and custom harness
        // commands) may create their own provider/tool children. Keep the
        // provider in a dedicated POSIX process group so cancellation and idle
        // termination close the whole tree instead of only the root process.
        ...(process.platform !== 'win32' ? { detached: true } : {}),
      });
    }
    // The provider can exit while the async Run bookkeeping below is still
    // in progress. Capture lifecycle events immediately; replay them only
    // after stdout readers and terminalization handlers are installed.
    proc.on('error', error => captureProcessEvent('error', error));
    proc.once('exit', (code, signal) => captureProcessEvent('exit', code, signal));
    // Node may drain unused child pipes immediately after a fast exit. Claim
    // both pipes before any async bookkeeping, using bounded backpressure so
    // output survives until the real readers are installed.
    providerStdoutStream = new PassThrough({ highWaterMark: 64 * 1024 });
    providerStderrStream = new PassThrough({ highWaterMark: 64 * 1024 });
    providerStdoutStream.on('error', error => { earlyStdoutError ||= error; });
    providerStderrStream.on('error', error => { earlyStderrError ||= error; });
    proc.stdout.on('error', error => providerStdoutStream.destroy(error));
    proc.stderr.on('error', error => providerStderrStream.destroy(error));
    proc.stdout.pipe(providerStdoutStream);
    proc.stderr.pipe(providerStderrStream);
    if (Number.isInteger(proc.exitCode) || (typeof proc.signalCode === 'string' && proc.signalCode))
      captureProcessEvent('exit', proc.exitCode, proc.signalCode);
    if (windowsJob) await updateRun(runId, (current) => ({ ...current, windowsJobObjectManaged: true, windowsJobObjectCreation: 'suspended-create-assign-resume' }));
    if (sandboxProviderSeeds?.seeds.length) {
      deliverReadOnlyProviderSeeds(proc, sandboxProviderSeeds);
      providerSeedsDelivered = true;
    }
  } catch (error) {
    await readOnlyCodexExecutor?.stop();
    if (sandboxEmptyDir) { try { rmSync(sandboxEmptyDir, { recursive: true, force: true }); } catch {} }
    throw error;
  } finally {
    if (!providerSeedsDelivered) closeReadOnlyProviderSeeds(sandboxProviderSeeds);
  }
  if (readOnlyCodexExecutor) {
    proc.once('exit', () => { void readOnlyCodexExecutor.stop(); });
    proc.once('error', () => { void readOnlyCodexExecutor.stop(); });
  }
  if (sandboxEmptyDir) {
    proc.once('close', () => {
      try { rmSync(sandboxEmptyDir, { recursive: true, force: true }); } catch {}
    });
  }

  await updateRun(runId, (current) => ({
    ...current,
    toolProcessId: proc.pid,
  }));

  let cancelSent = false;
  let lastOutputAt = Date.now();
  // `lastOutputAt` is refreshed both when a line arrives and when its ordered
  // handler starts.  The arrival timestamp is the liveness signal: a slow
  // spool writer must not make a healthy provider look idle.
  let lastProviderLineAt = lastOutputAt;
  let providerBytesSeen = false;
  let providerTerminalSeen = false;
  let providerTerminalFailureReason = '';
  let providerProtocolErrorPreview = '';
  const providerNeedsTerminalEvidence = providerRequiresTerminalEvidence(runtimeFamily, { acp: acp === true });
  let controlFlushPromise = null;
  let staleClaudeResumeDetected = false;
  let piTerminalSeen = false;
  const acpState = acp === true ? {
    sessionId: '',
    requestedSessionId: runtimeFamily === 'hermes-acp'
      ? String(manifest.options?.providerResumeId || manifest.options?.hermesSessionId || '').trim()
      : '',
    promptSent: false,
    sessionStartRequested: false,
    startupTimer: null,
    modeSwitchRequested: false,
    modeSwitchTimer: null,
    terminalSeen: false,
    hadError: false,
    failureReason: '',
  } : null;
  let providerHeartbeatTimer = null;
  let providerHeartbeatWritePromise = null;
  let providerHeartbeatCount = 0;
  let runnerHeartbeatTimer = null;
  let runnerHeartbeatWritePromise = null;
  let runnerHeartbeatCount = 0;
  const terminateManagedProcess = () => {
    if (windowsJob) return windowsJob.terminate(0xC0DE).catch(() => {});
    terminateProviderProcessTree(proc, 'SIGTERM');
    return Promise.resolve();
  };
  const idleTimeoutMs = Number.isFinite(Number(process.env.AGENTOC_RUN_IDLE_TIMEOUT_MS))
    && Number(process.env.AGENTOC_RUN_IDLE_TIMEOUT_MS) > 0
    ? Number(process.env.AGENTOC_RUN_IDLE_TIMEOUT_MS)
    : (runtimeFamily === 'agy-json' || runtimeFamily === 'agy-stream-json'
      ? DEFAULT_AGY_IDLE_TIMEOUT_MS
      : defaultIdleTimeoutForRuntime(runtimeFamily));
  const codexToolIdleTimeoutMs = appServerState
    ? readPositiveDurationEnv(
      'AGENTOC_CODEX_TOOL_IDLE_TIMEOUT_MS',
      Math.max(idleTimeoutMs, DEFAULT_CODEX_TOOL_IDLE_TIMEOUT_MS),
    )
    : idleTimeoutMs;
  const codexTurnIdleTimeoutMs = appServerState
    ? readPositiveDurationEnv(
      'AGENTOC_CODEX_TURN_IDLE_TIMEOUT_MS',
      // An explicitly configured generic timeout remains an operator override
      // for compatibility; the longer Codex default applies only when the
      // generic value was not supplied by the deployment.
      process.env.AGENTOC_RUN_IDLE_TIMEOUT_MS
        ? idleTimeoutMs
        : DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS,
    )
    : idleTimeoutMs;
  const codexIdleInterruptGraceMs = appServerState
    ? readPositiveDurationEnv(
      'AGENTOC_CODEX_IDLE_INTERRUPT_GRACE_MS',
      DEFAULT_CODEX_IDLE_INTERRUPT_GRACE_MS,
    )
    : DEFAULT_CODEX_IDLE_INTERRUPT_GRACE_MS;
  const codexStartupTimeoutMs = appServerState
    ? readPositiveDurationEnv(
      'AGENTOC_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS',
      DEFAULT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
    )
    : 0;
  const idleCheckIntervalMs = Number.isFinite(Number(process.env.AGENTOC_RUN_IDLE_CHECK_INTERVAL_MS))
    && Number(process.env.AGENTOC_RUN_IDLE_CHECK_INTERVAL_MS) > 0
    ? Number(process.env.AGENTOC_RUN_IDLE_CHECK_INTERVAL_MS)
    : IDLE_CHECK_INTERVAL_MS;

  const providerHeartbeatEnabled = isAgyFamily === true
    || isAgyRuntime({ toolId: manifest.tool, runtimeFamily });
  const providerHeartbeatIntervalMs = resolveProviderHeartbeatIntervalMs(process.env);
  const providerOutputIdleDiagnosticMs = resolveProviderOutputIdleDiagnosticMs(process.env);

  const writeProviderHeartbeat = () => {
    if (!providerHeartbeatEnabled || providerHeartbeatWritePromise) return providerHeartbeatWritePromise;
    providerHeartbeatCount += 1;
    const snapshot = buildProviderLivenessSnapshot({
      runtimeFamily,
      nowMs: Date.now(),
      lastOutputAtMs: lastOutputAt,
      heartbeatCount: providerHeartbeatCount,
      outputIdleDiagnosticMs: providerOutputIdleDiagnosticMs,
    });
    providerHeartbeatWritePromise = updateRun(runId, (current) => {
      if (!current || ['completed', 'failed', 'cancelled'].includes(current.state)) return current;
      return {
        ...current,
        providerLiveness: snapshot,
      };
    }).catch((error) => {
      console.error(`[sidecar] Failed to persist provider heartbeat for run ${runId}: ${normalizeErrorMessage(error)}`);
      return null;
    }).finally(() => {
      providerHeartbeatWritePromise = null;
    });
    return providerHeartbeatWritePromise;
  };

  const stopProviderHeartbeat = () => {
    if (providerHeartbeatTimer) {
      clearInterval(providerHeartbeatTimer);
      providerHeartbeatTimer = null;
    }
  };

  // Every Harness gets a small durable liveness edge. Provider-specific
  // heartbeats (currently AgY) carry richer output diagnostics, but the
  // control plane still needs one provider-neutral signal to distinguish a
  // quiet healthy process from an orphan after restart.
  const writeRunnerHeartbeat = () => {
    if (runnerHeartbeatWritePromise) return runnerHeartbeatWritePromise;
    runnerHeartbeatCount += 1;
    runnerHeartbeatWritePromise = updateRun(runId, (current) => {
      if (!current || ['completed', 'failed', 'cancelled'].includes(current.state)) return current;
      return {
        ...current,
        runnerHeartbeatAt: nowIso(),
        runnerHeartbeatCount,
        // This is provider-neutral byte-level liveness. It deliberately does
        // not claim the bytes were semantically projected or visible; the
        // observer records those two later stages separately.
        ...(providerBytesSeen ? { providerLastByteAt: new Date(lastProviderLineAt).toISOString() } : {}),
      };
    }).catch((error) => {
      console.error(`[sidecar] Failed to persist runner heartbeat for run ${runId}: ${normalizeErrorMessage(error)}`);
      return null;
    }).finally(() => {
      runnerHeartbeatWritePromise = null;
    });
    return runnerHeartbeatWritePromise;
  };

  const stopRunnerHeartbeat = () => {
    if (runnerHeartbeatTimer) {
      clearInterval(runnerHeartbeatTimer);
      runnerHeartbeatTimer = null;
    }
  };

  void writeRunnerHeartbeat();
  runnerHeartbeatTimer = setInterval(() => {
    void writeRunnerHeartbeat();
  }, resolveProviderHeartbeatIntervalMs(process.env));
  runnerHeartbeatTimer.unref?.();

  if (providerHeartbeatEnabled) {
    void writeProviderHeartbeat();
    providerHeartbeatTimer = setInterval(() => {
      void writeProviderHeartbeat();
    }, providerHeartbeatIntervalMs);
    providerHeartbeatTimer.unref?.();
  }

  async function flushControlChannel() {
    if (controlFlushPromise) return controlFlushPromise;
    controlFlushPromise = (async () => {
      const current = await getRun(runId);
      if (appServerState) {
        await flushCodexAppServerApprovalResponses(proc, appServerState, current);
        await flushCodexAppServerSteerQueue(proc, appServerState, current);
      }
      if (claudeBidiState) {
        await flushClaudeBidiApprovalResponses(proc, claudeBidiState, current);
        await flushClaudeBidiSteerQueue(proc, claudeBidiState, current);
      }
      if (!current?.cancelRequested || cancelSent) return;
      cancelSent = true;
      if (appServerState) appServerState.startupCancelled = true;
      appServerState?.accountModelCatalog?.cancel();
      if (appServerState && maybeInterruptCodexAppServerTurn(proc, appServerState)) {
        setTimeout(() => {
          if (appServerState.terminalSeen || proc.exitCode !== null) return;
          try {
            void terminateManagedProcess();
          } catch {}
        }, 5000);
        return;
      }
      if (claudeBidiState && maybeInterruptClaudeBidiTurn(proc, claudeBidiState)) {
        setTimeout(() => {
          if (claudeBidiState.terminalSeen || proc.exitCode !== null) return;
          try {
            void terminateManagedProcess();
          } catch {}
        }, 5000);
        return;
      }
      try {
        void terminateManagedProcess();
      } catch {}
    })().catch((error) => {
      console.error(`[sidecar] Failed to flush control channel for run ${runId}: ${normalizeErrorMessage(error)}`);
    }).finally(() => {
      controlFlushPromise = null;
    });
    return controlFlushPromise;
  }

  async function waitForControlFlush() {
    if (!controlFlushPromise) return;
    await controlFlushPromise;
  }

  const cancelTimer = setInterval(() => {
    void flushControlChannel();
  }, 250);

  let idleCheckInFlight = false;
  const idleTimer = setInterval(() => {
    if (cancelSent) return;
    if (hasPendingRuntimeApproval(appServerState) || hasPendingRuntimeApproval(claudeBidiState)) return;
    // P1c-4: a held privileged-batch gate (provider blocked on stdin awaiting the
    // batch approval) is a legitimate pause, not an idle stall — exempt it from
    // the idle-kill timer just like a pending runtime approval. Default OFF = no-op.
    if (hasPendingPrivilegedBatch(appServerState) || hasPendingPrivilegedBatch(claudeBidiState)) return;
    if (idleCheckInFlight) return;
    idleCheckInFlight = true;
    void getRun(runId).then((currentRun) => {
      if (cancelSent || hasPendingApprovedAction(currentRun)) return;
      const codexToolActive = hasActiveCodexAppServerToolItem(appServerState);
      const effectiveIdleTimeoutMs = codexToolActive
        ? codexToolIdleTimeoutMs
        : (appServerState ? codexTurnIdleTimeoutMs : idleTimeoutMs);
      const lastActivityAt = Math.max(
        lastOutputAt,
        lastProviderLineAt,
        Number(appServerState?.lastControlActivityAt) || 0,
        Number(claudeBidiState?.lastControlActivityAt) || 0,
      );
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs < effectiveIdleTimeoutMs) return;
      cancelSent = true;
      if (appServerState) appServerState.startupCancelled = true;
      appServerState?.accountModelCatalog?.cancel();
      const idleMinutes = Math.round(idleMs / 60000);
      const activeItems = appServerState?.activeItems instanceof Map
        ? [...appServerState.activeItems.entries()].map(([id, item]) => ({
          id,
          type: item?.type || '',
          tool: item?.tool === true,
          startedAtMs: item?.startedAtMs || null,
        }))
        : [];
      const idleReason = appServerState
        ? (codexToolActive
          ? `Codex app-server tool execution stalled after ${idleMinutes} minutes of inactivity`
          : `Codex app-server turn stalled after ${idleMinutes} minutes of inactivity`)
        : `Tool process stalled after ${idleMinutes} minutes of inactivity`;
      if (appServerState) {
        appServerState.idleTerminationReason = idleReason;
        appServerState.idleTerminationGraceTimer = null;
      }
      console.error(`[sidecar] ${idleReason} for run ${runId}`);
      void (async () => {
        await appendRunSpoolRecord(runId, {
          ts: nowIso(),
          stream: 'error',
          line: `${idleReason}; activeItems=${JSON.stringify(activeItems)}`,
          json: {
            type: 'sidecar.diagnostic',
            message: idleReason,
            details: {
              idleMs,
              idleTimeoutMs: effectiveIdleTimeoutMs,
              activeItems,
              interruptGraceMs: appServerState ? codexIdleInterruptGraceMs : 0,
            },
          },
        });
      })();
      if (appServerState && maybeInterruptCodexAppServerTurn(proc, appServerState)) {
        // Give app-server a chance to emit turn/completed(status=interrupted),
        // preserving the real stall diagnosis and allowing it to flush any
        // final provider diagnostics. A hard kill remains the bounded fallback.
        appServerState.idleTerminationGraceTimer = setTimeout(() => {
          appServerState.idleTerminationGraceTimer = null;
          if (appServerState.terminalSeen || proc.exitCode !== null) return;
          void terminateManagedProcess();
        }, codexIdleInterruptGraceMs);
        appServerState.idleTerminationGraceTimer.unref?.();
        return;
      }
      void terminateManagedProcess();
      if (appServerState) {
        appServerState.idleTerminationGraceTimer = setTimeout(() => {
          appServerState.idleTerminationGraceTimer = null;
          if (appServerState.terminalSeen || proc.exitCode !== null) return;
          void terminateManagedProcess();
        }, codexIdleInterruptGraceMs);
        appServerState.idleTerminationGraceTimer.unref?.();
      } else {
        setTimeout(() => {
          void terminateManagedProcess();
        }, 5000).unref?.();
      }
    }).catch(() => {}).finally(() => {
      idleCheckInFlight = false;
    });
  }, idleCheckIntervalMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  // Resume identifiers and Codex thread metadata are the only Run fields
  // needed while decoding provider frames. Reading status.json for every
  // line made a high-volume JSONL harness pay a disk round-trip per token and
  // could starve the spool writer until the watchdog declared a healthy run
  // stalled. Keep the snapshot current only when this stream actually changes
  // one of those fields; control/cancel polling still reads the durable Run on
  // its own timer.
  let providerRunSnapshot = run;
  const claudeThinkingTokenSampler = isClaudeFamily
    ? createClaudeThinkingTokenSampler({ intervalMs: 1000 })
    : null;
  const flushPendingClaudeThinkingTokens = async () => {
    const pendingThinkingTokens = claudeThinkingTokenSampler?.flush();
    if (!pendingThinkingTokens) return;
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      json: pendingThinkingTokens,
    }, { buffered: true });
  };
  const persistProviderRunPatch = async (fields = {}) => {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return providerRunSnapshot;
    if (entries.every(([key, value]) => Object.is(providerRunSnapshot?.[key], value))) {
      return providerRunSnapshot;
    }
    providerRunSnapshot = await updateRunFieldsIfChanged(runId, fields) || providerRunSnapshot;
    return providerRunSnapshot;
  };

  const recordStdoutLine = async (line) => {
    lastOutputAt = Date.now();
    let parsed = null;
    let spoolLine = line;
    try {
      parsed = JSON.parse(line);
      // Shared upstreams may emit thread events before this Run has sent its
      // own thread request. Such frames cannot select a resume cursor, finish
      // the Run or expose another thread's payload in its spool.
      if (isUnrequestedCodexThreadEvent(appServerState, parsed)) {
        await logSidecarDiagnostic(runId, 'CODEX_UNREQUESTED_THREAD_EVENT', {
          frameSha256: createHash('sha256').update(line).digest('hex'),
          frameBytes: Buffer.byteLength(line, 'utf8'),
          agentoc_intermediate: true,
        });
        return;
      }
      if (claudeBidiState && isClaudeBidiTurnTerminal(parsed) && claudeBidiState.steerAwaitingTurnEnd) {
        parsed = { ...parsed, agentoc_intermediate: true };
        spoolLine = JSON.stringify(parsed);
      }
      const enriched = fileChangeStatsTracker.observeProviderPayload(parsed);
      if (enriched && enriched !== parsed) {
        parsed = enriched;
        spoolLine = JSON.stringify(enriched);
      }
    } catch {}
    const thinkingTokenSample = claudeThinkingTokenSampler?.observe(parsed, Date.now());
    if (thinkingTokenSample?.handled && thinkingTokenSample.persist !== true) {
      // The cumulative counter is sampled; the adjacent thinking_delta stays
      // in the raw spool, so provider activity and replay evidence are intact.
      return;
    }
    if (!parsed && typeof line === 'string' && line.trim()) {
      providerErrorPreview = clipDiagnosticMessage(
        `${providerErrorPreview} ${line.trim()}`.trim(),
        2000,
      );
    }
    const providerTerminalFrame = classifyProviderTerminalFrame(runtimeFamily, parsed, { acp: acp === true });
    if (providerTerminalFrame?.kind === 'completed') {
      providerTerminalSeen = true;
      providerTerminalFailureReason = '';
    } else if (providerTerminalFrame?.kind === 'failed') {
      providerTerminalSeen = true;
      providerTerminalFailureReason = providerTerminalFrame.reason;
      providerProtocolErrorPreview = providerTerminalFrame.reason;
    } else if (providerTerminalFrame?.kind === 'error') {
      // A provider may emit a retryable error before a later successful
      // terminal frame. Retain it as a fallback diagnosis, but do not mark the
      // Run terminal until the process actually ends or a terminal frame says
      // so.
      providerProtocolErrorPreview = providerTerminalFrame.reason;
    }
    if (parsed && (parsed.error || parsed.method === 'error' || parsed.params?.turn?.status === 'failed')) {
      providerErrorPreview = clipDiagnosticMessage(
        readStructuredProviderFailureReason(parsed, providerErrorPreview || 'Provider reported an error'),
        2000,
      );
    }
    if (acpState && parsed) {
      if (parsed.id === 'agentoc-initialize') {
        if (!isAcpInitializeAccepted(parsed) || acpState.sessionStartRequested || !proc.stdin?.writable) {
          acpState.hadError = true;
          acpState.failureReason = 'ACP initialization was not confirmed';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-initialize' });
          await terminateManagedProcess();
          return;
        }
        try {
          proc.stdin.write(buildAcpSessionInput({
            cwd: resolvedFolder.cwd,
            mcpServers: acpMcpServers,
            ...(runtimeFamily === 'hermes-acp' && acpState.requestedSessionId
              ? { resumeSessionId: acpState.requestedSessionId }
              : {}),
          }));
          acpState.sessionStartRequested = true;
        } catch {
          acpState.hadError = true;
          acpState.failureReason = 'ACP session start could not be sent';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-initialize' });
          await terminateManagedProcess();
          return;
        }
      }
      if (parsed.method === 'session/request_permission') {
        const denial = buildAcpUnattendedPermissionDenial(parsed, acpState.sessionId);
        if (!denial || !proc.stdin?.writable) {
          acpState.hadError = true;
          acpState.failureReason = 'ACP permission request could not be safely denied';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-permission' });
          await terminateManagedProcess();
          return;
        }
        await logSidecarDiagnostic(runId, 'ACP permission request automatically denied', {
          phase: 'acp-permission',
          requestId: parsed.id,
          cancelled: denial.cancelled,
        });
        try {
          proc.stdin.write(denial.line);
        } catch {
          acpState.hadError = true;
          acpState.failureReason = 'ACP permission denial could not be sent';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-permission' });
          await terminateManagedProcess();
          return;
        }
        if (denial.cancelled) {
          acpState.hadError = true;
          acpState.failureReason = 'ACP permission request offered no one-time reject option';
          void terminateAfterProviderTerminal(runId, terminateManagedProcess, proc);
        }
      }
      if (parsed.id === 'agentoc-session-new' || parsed.id === 'agentoc-session-load') {
        if (!acpState.sessionStartRequested || acpState.sessionId) {
          acpState.hadError = true;
          acpState.failureReason = 'ACP session response arrived out of sequence';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-session' });
          await terminateManagedProcess();
          return;
        }
        const sessionId = acpSessionIdFromResponse(parsed)
          || (parsed.id === 'agentoc-session-load' ? acpState.requestedSessionId : '');
        const error = acpResponseError(parsed);
        if (error || !sessionId) {
          acpState.hadError = true;
          acpState.failureReason = error || 'ACP session start returned no session id';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-session' });
          await terminateManagedProcess();
          return;
        } else {
          if (acpState.startupTimer) clearTimeout(acpState.startupTimer);
          acpState.startupTimer = null;
          acpState.sessionId = sessionId;
          if (runtimeFamily === 'kimi-code-acp') {
            const modeSwitch = buildAcpModeSwitchInput(
              sessionId,
              permissionMode,
              acpAvailableModesFromResponse(parsed),
            );
            if (!modeSwitch || !proc.stdin?.writable) {
              acpState.hadError = true;
              acpState.failureReason = `Kimi ACP did not advertise the required ${permissionMode} mode`;
              await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-mode' });
              await terminateManagedProcess();
              return;
            }
            acpState.modeSwitchRequested = true;
            try {
              proc.stdin.write(modeSwitch);
            } catch {
              acpState.hadError = true;
              acpState.failureReason = 'Kimi ACP mode switch could not be sent';
              await terminateManagedProcess();
              return;
            }
            acpState.modeSwitchTimer = setTimeout(() => {
              if (acpState.promptSent || proc.exitCode !== null || proc.signalCode !== null) return;
              acpState.hadError = true;
              acpState.failureReason = 'Kimi ACP mode switch timed out';
              void (async () => {
                try {
                  await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-mode' });
                } finally {
                  await terminateManagedProcess();
                }
              })().catch(() => {});
            }, 30_000);
            acpState.modeSwitchTimer.unref?.();
          } else if (!acpState.promptSent) {
            if (!proc.stdin?.writable) {
              acpState.hadError = true;
              acpState.failureReason = 'ACP prompt could not be sent';
              await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-session' });
              await terminateManagedProcess();
              return;
            }
            try {
              proc.stdin.write(buildAcpPromptInput(sessionId, prompt));
              acpState.promptSent = true;
            } catch {
              acpState.hadError = true;
              acpState.failureReason = 'ACP prompt could not be sent';
              await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-session' });
              await terminateManagedProcess();
              return;
            }
          }
        }
      } else if (runtimeFamily === 'kimi-code-acp' && parsed.id === 'agentoc-set-mode') {
        if (acpState.modeSwitchTimer) clearTimeout(acpState.modeSwitchTimer);
        acpState.modeSwitchTimer = null;
        if (!acpState.modeSwitchRequested || !isAcpModeSwitchAccepted(parsed)) {
          acpState.hadError = true;
          acpState.failureReason = 'Kimi ACP mode switch was not confirmed';
          await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-mode' });
          await terminateManagedProcess();
          return;
        }
        if (!acpState.promptSent) {
          if (!proc.stdin?.writable) {
            acpState.hadError = true;
            acpState.failureReason = 'Kimi ACP prompt could not be sent after mode switch';
            await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-mode' });
            await terminateManagedProcess();
            return;
          }
          try {
            proc.stdin.write(buildAcpPromptInput(acpState.sessionId, prompt));
            acpState.promptSent = true;
          } catch {
            acpState.hadError = true;
            acpState.failureReason = 'Kimi ACP prompt could not be sent after mode switch';
            await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-mode' });
            await terminateManagedProcess();
            return;
          }
        }
      } else if (parsed.id === 'agentoc-prompt') {
        const error = acpResponseError(parsed);
        acpState.hadError = Boolean(error) || acpState.hadError;
        acpState.failureReason = error || acpState.failureReason;
        acpState.terminalSeen = true;
        try { proc.stdin.end(); } catch {}
        void terminateAfterProviderTerminal(runId, terminateManagedProcess, proc);
      } else if (parsed.error) {
        acpState.hadError = true;
        acpState.failureReason = acpResponseError(parsed) || 'ACP request failed';
        acpState.terminalSeen = true;
        void terminateAfterProviderTerminal(runId, terminateManagedProcess, proc);
      }
    }
    if (process.platform === 'darwin' && codexAppServerBrokered && appServerState && parsed) {
      const cleanupStatus = readMacCleanupNotification(parsed, { threadId: appServerState.threadId, runId });
      if (cleanupStatus) {
        appServerState.macCancellationCleanupStatus = cleanupStatus;
        return;
      }
    }
    if (appServerState && parsed && await maybeConsumeCodexAppServerGoalResponse(runId, appServerState, parsed)) {
      return;
    }
    if (codexAppServerBrokered && parsed?.method === 'agentoc/windowsHook' && parsed.id != null) {
      const result = await evaluateRunBoundCodexWindowsHook(parsed.params?.event, {
        active: appServerState?.startedTurn === true && !appServerState.terminalSeen && !appServerState.hadError,
        threadId: appServerState?.threadId, turnId: appServerState?.turnId,
        enabled: windowsElevationHook, env: spawnEnv,
      }).catch(() => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'The Ragent Windows operation check failed.' } }));
      writeCodexAppServerMessage(proc, { id: parsed.id, result });
      return;
    }
    if (appServerState?.codexManagedHookSetup && parsed && appServerState.codexManagedHookSetup.consume(parsed)) {
      if (appServerState.hadError) await terminateManagedProcess();
      return;
    }
    if (appServerState && parsed && consumeCodexSharedHookRegistration(appServerState, parsed)) {
      if (appServerState.hadError) await terminateManagedProcess();
      return;
    }
    if (appServerState?.readOnlyEnvironmentSetup && parsed
        && await appServerState.readOnlyEnvironmentSetup.consume(parsed)) {
      if (appServerState.hadError) await terminateManagedProcess();
      return;
    }
    if (appServerState?.accountModelCatalog && parsed
        && await appServerState.accountModelCatalog.consume(parsed)) return;
    if (appServerState && parsed && handleCodexAppServerInitializeResponse(proc, appServerState, parsed)) {
      if (appServerState.hadError) {
        await logSidecarDiagnostic(runId, appServerState.failureReason, { phase: 'codex-app-server-initialize' });
        await terminateManagedProcess();
      }
      return;
    }
    if (appServerState && parsed && isCodexAppServerStaleResumeError(parsed, appServerState)) {
      const staleThreadId = appServerState.threadId;
      try {
        const accountSources = JSON.parse(process.env.AGENTOC_CODEX_ROLLOUT_SOURCES || '[]');
        if (!Array.isArray(accountSources)) throw new Error('Invalid managed rollout sources');
        if (await retryManagedCodexRolloutResume(proc, appServerState, runnerCodexHomeDir, findManagedCodexRollout, accountSources)) {
          await logSidecarDiagnostic(runId, 'Codex thread index missed an existing managed rollout; retrying resume', { staleThreadId });
          return;
        }
      } catch (error) {
        markCodexAppServerFailure(appServerState, { error: { message: 'Could not safely recover the existing Codex session' } });
        await logSidecarDiagnostic(runId, 'Codex managed rollout recovery failed', {
          phase: 'codex-app-server-rollout-recovery', staleThreadId, error: normalizeErrorMessage(error),
        });
        await terminateManagedProcess();
        return;
      }
      if (recoverCodexAppServerFromStaleResume(proc, appServerState)) {
        await logSidecarDiagnostic(runId, 'Codex thread resume target was unavailable; started a fresh thread', {
          staleThreadId,
          recovery: 'thread-start',
        });
        return;
      }
      await logSidecarDiagnostic(runId, appServerState.failureReason || 'Codex stale-resume recovery could not write to app-server', {
        phase: 'codex-app-server-stale-resume-recovery',
        staleThreadId,
        providerErrorCode: appServerState.providerErrorCode,
      });
      await terminateManagedProcess();
      return;
    }
    if (
      appServerState
      && parsed?.error
      && parsed.id === appServerState.threadRequestId
    ) {
      const reason = markCodexAppServerFailure(
        appServerState,
        parsed,
        appServerState.useResume
          ? 'Codex app-server thread resume failed'
          : 'Codex app-server thread start failed',
      );
      await logSidecarDiagnostic(runId, reason, {
        phase: appServerState.useResume ? 'codex-app-server-thread-resume' : 'codex-app-server-thread-start',
        providerErrorCode: appServerState.providerErrorCode,
        providerErrorMethod: appServerState.providerErrorMethod,
      });
      await terminateManagedProcess();
      return;
    }
    const codexMcpResponse = appServerState && parsed?.id === appServerState.mcpStatusRequestId;
    if (
      appServerState
      && !appServerState.startedTurn
      && !codexMcpResponse
      && (
        (parsed?.method === 'error' && parsed?.params?.willRetry !== true)
        || (parsed?.error && parsed?.id !== appServerState.initializeRequestId)
      )
    ) {
      const reason = markCodexAppServerFailure(
        appServerState,
        parsed,
        'Codex app-server failed during startup',
      );
      await logSidecarDiagnostic(runId, reason, {
        phase: appServerState.providerStage || 'codex-app-server-startup',
        providerErrorCode: appServerState.providerErrorCode,
        providerErrorMethod: appServerState.providerErrorMethod,
      });
      await terminateManagedProcess();
      return;
    }
    if (appServerState && parsed) {
      const consumedMcpResponse = await consumeCodexAppServerMcpStatusList(
        runId,
        appServerState,
        proc,
        parsed,
        terminateManagedProcess,
      );
      if (consumedMcpResponse && appServerState.mcpFailureReason) return;
      const consumedMcpStartup = await observeCodexAppServerMcpStartupStatus(
        runId,
        appServerState,
        proc,
        parsed,
        terminateManagedProcess,
      );
      if (consumedMcpStartup && appServerState.mcpFailureReason) return;
    }
    if (parsed?.type === 'turn.completed') {
      await appendFileChangeStatsSummarySafely(runId, fileChangeStatsTracker);
    }
    const codexEventThreadId = appServerState && parsed
      ? readCodexAppServerEventThreadId(parsed)
      : '';
    const foreignCodexThreadEvent = !!(
      appServerState?.threadId
      && codexEventThreadId
      && codexEventThreadId !== appServerState.threadId
    );
    if (appServerState && parsed && !foreignCodexThreadEvent) {
      await trackCodexAppServerApprovalRequest(runId, appServerState, parsed, proc);
    }
    if (claudeBidiState && parsed) {
      await trackClaudeBidiApprovalRequest(runId, claudeBidiState, parsed, proc);
    }
    if (foreignCodexThreadEvent) {
      parsed = { ...parsed, agentoc_intermediate: true };
      spoolLine = JSON.stringify(parsed);
    }
    const activeAppServerEvent = appServerState
      ? isCodexAppServerStateEvent(appServerState, parsed)
      : false;
    // Capture the turn identity before evaluating terminality.  A few
    // app-server versions can deliver turn/completed ahead of turn/started;
    // without this ordering the completion is permanently downgraded to an
    // intermediate frame and the Run waits until the watchdog fires.
    const capturedTurnIdBeforeTerminal = activeAppServerEvent
      ? maybeCaptureCodexAppServerTurnId(appServerState, parsed)
      : '';
    const codexTerminalFrame = !!(
      appServerState
      && !foreignCodexThreadEvent
      && parsed
      && (
        parsed.method === 'turn/completed'
        || (parsed.method === 'error' && parsed.params?.willRetry !== true)
        || (parsed.error && parsed.id === CODEX_APP_SERVER_REQUEST_IDS.turn)
      )
    );
    const currentCodexTerminalFrame = codexTerminalFrame
      && activeAppServerEvent
      && isCodexAppServerTurnTerminalMessage(parsed, appServerState.turnId);
    if (appServerState && parsed && activeAppServerEvent) {
      observeCodexAppServerItem(appServerState, parsed);
      if (currentCodexTerminalFrame) appServerState.activeItems.clear();
    }
    if (codexTerminalFrame && !currentCodexTerminalFrame) {
      // Keep stale/malformed provider frames in the raw spool for diagnostics,
      // but prevent the adapter and observer from treating them as completion.
      parsed = { ...parsed, agentoc_intermediate: true };
      spoolLine = JSON.stringify(parsed);
    }
    if (claudeThinkingTokenSampler && (parsed?.type === 'assistant' || providerTerminalFrame)) {
      await flushPendingClaudeThinkingTokens();
    }
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      line: spoolLine,
      ...(parsed ? { json: parsed } : {}),
    }, { buffered: true });
    if (isPiFamily && readPiTerminalOutcome(parsed) && !piTerminalSeen) {
      piTerminalSeen = true;
      try { proc.stdin.end(); } catch {}
      void terminateAfterProviderTerminal(runId, terminateManagedProcess, proc);
    }
    if (
      parsed
      && isProviderNativeDelegationEvidence(
        parsed,
        isClaudeFamily ? 'claude' : isCodexAppServerFamily ? 'codex' : '',
      )
    ) {
      scheduleProviderNativeDelegationReconcile(runId, {
        runId,
        getRun,
        readRunSpoolRecords,
        streamRunSpoolRecords,
        appendRunSpoolRecord,
        updateRun,
        writeRunResult,
      });
    }
    const currentRun = providerRunSnapshot || run || {};
    const expectedCodexThreadId = appServerState?.threadId
      || currentRun?.appServerThreadId
      || currentRun?.codexThreadId
      || '';
    const resumeUpdate = captureResume(currentRun, parsed, {
      expectedCodexThreadId,
      runtimeFamily,
    });
    const runPatch = resumeUpdate ? { ...resumeUpdate } : {};
    if (isClaudeFamily && parsed && !staleClaudeResumeDetected && isClaudeResumeNotFoundPayload(parsed)) {
      staleClaudeResumeDetected = true;
      if (claudeBidiState) {
        claudeBidiState.staleResumeDetected = true;
      }
      runPatch.staleClaudeResumeDetected = true;
      runPatch.staleResumeProvider = 'claude';
    }
    if (appServerState && parsed) {
      const threadStartResult = parsed.id === appServerState.threadRequestId
        && parsed.result?.thread
        ? parsed.result
        : null;
      if (appServerState.agentocApprovalGate && threadStartResult) {
        const approvalContext = validateCodexAppServerApprovalContext({
          response: threadStartResult,
          cwd: appServerState.cwd,
          permissionMode: appServerState.permissionMode,
        });
        if (!approvalContext.ok) {
          const reason = approvalContext.reasonCode || 'CODEX_APPROVAL_CONTEXT_UNVERIFIED';
          appServerState.approvalPolicyVerified = false;
          markCodexAppServerFailure(appServerState, {
            error: { code: reason, message: 'Codex did not confirm the expected Ragent approval policy and workspace boundary' },
          }, 'Codex approval policy could not be verified');
          await appendRunSpoolRecord(runId, {
            ts: nowIso(),
            stream: 'error',
            json: { type: 'status', role: 'system', code: reason, content: 'Codex approval policy could not be verified; the Run was stopped before its prompt started' },
          });
          await logSidecarDiagnostic(runId, 'Codex approval context verification failed before turn/start', {
            phase: 'codex-app-server-approval-policy-verification',
            reasonCode: reason,
          });
          await terminateManagedProcess();
          return;
        }
        appServerState.approvalPolicyVerified = true;
      }
      if (maybeStartCodexAppServerTurn(proc, appServerState, parsed)) {
        runPatch.appServerThreadId = appServerState.threadId;
      }
      if (appServerState.mcpRequired && appServerState.threadId) {
        armCodexAppServerMcpReadinessTimeout(runId, appServerState, terminateManagedProcess);
        runPatch.appServerThreadId = appServerState.threadId;
      }
      const turnId = activeAppServerEvent
        ? (capturedTurnIdBeforeTerminal || maybeCaptureCodexAppServerTurnId(appServerState, parsed))
        : '';
      if (turnId) {
        runPatch.appServerThreadId = appServerState.threadId
          || currentRun.appServerThreadId
          || currentRun.codexThreadId
          || null;
        runPatch.appServerTurnId = turnId;
      }
      await persistProviderRunPatch(runPatch);
      if (currentCodexTerminalFrame) {
        const turnStatus = parsed.params?.turn?.status;
        if (parsed.error || parsed.method === 'error' || ['failed', 'interrupted'].includes(turnStatus)) {
          appServerState.hadError = true;
          appServerState.failureReason = readStructuredProviderFailureReason(
            parsed,
            turnStatus === 'interrupted'
              ? 'Codex app-server turn interrupted before completion'
              : 'Codex app-server reported an error',
          );
          // 空输出/上游错误（luna 偶发只思考不输出轮 → 代理 stream_truncated/upstream_error，
          // 客户端 400 形态不自动重试）→ 自动重发该 turn，避免用户看到 systemError。
          const retryCount = Number(appServerState.turnRetryCount) || 0;
          if (
            retryCount < CODEX_APP_SERVER_TURN_RETRY_LIMIT
            && /stream[_ ]truncated|no output was produced|finish_reason[\"':\s]*null|upstream_error/i.test(appServerState.failureReason)
          ) {
            appServerState.turnRetryCount = retryCount + 1;
            appServerState.hadError = false;
            appServerState.failureReason = '';
            appServerState.turnId = '';
            appServerState.activeItems.clear();
            // 指数退避再重发：上游空响应常以 10s+ 窗口性出现（并发/恢复风暴诱发），
            // 立即连发会全部撞进窗口；等待 3s/6s/12s 让重试尽量落在窗口外。
            //
            // 绝不能在 recordStdoutLine 的有序 Promise 链里 await 这个
            // backoff。Codex 可能在错误帧后继续吐出诊断、item 或 completion
            // 帧；把 sleep 放在链里会阻塞所有后续 stdout，制造“中间卡住”，
            // 并让退出时的 drain barrier 一起被拖住。
            const backoffMs = CODEX_APP_SERVER_TURN_RETRY_BACKOFF_BASE_MS * (2 ** retryCount);
            console.error(`[sidecar] run ${runId} empty-output/upstream error, backing off ${backoffMs}ms before retry ${retryCount + 1}/${CODEX_APP_SERVER_TURN_RETRY_LIMIT}`);
            providerTerminalSeen = false;
            appServerState.startedTurn = false;
            appServerState.providerStage = 'retry_wait';
            if (appServerState.turnRetryTimer) clearTimeout(appServerState.turnRetryTimer);
            appServerState.turnRetryTimer = setTimeout(() => {
              appServerState.turnRetryTimer = null;
              if (appServerState.terminalSeen || proc.exitCode !== null || !proc.stdin?.writable) return;
              const retryMessage = buildCodexAppServerTurnStartMessage({
                threadId: appServerState.threadId,
                text: appServerState.prompt,
                clientUserMessageId: `retry-${appServerState.requestId || runId}-${retryCount + 1}`,
                cwd: appServerState.cwd,
                model: appServerState.model,
                reasoningEffort: appServerState.reasoningEffort,
                interactionMode: appServerState.interactionMode,
                permissionMode: appServerState.permissionMode,
                agentocApprovalGate: appServerState.agentocApprovalGate,
                executionEnvironment: appServerState.executionEnvironment,
              });
              if (writeCodexAppServerMessage(proc, retryMessage)) {
                appServerState.startedTurn = true;
                appServerState.providerStage = 'turn_start_sent';
                console.error(`[sidecar] run ${runId} empty-output/upstream error, retried turn after backoff (${retryCount + 1}/${CODEX_APP_SERVER_TURN_RETRY_LIMIT})`);
                return;
              }
              appServerState.hadError = true;
              appServerState.providerStage = 'failed';
              appServerState.failureReason = 'Codex app-server stdin closed before retry turn could start';
              void terminateManagedProcess();
            }, backoffMs);
            appServerState.turnRetryTimer.unref?.();
            return;
          }
        }
        appServerState.providerStage = appServerState.hadError ? 'failed' : 'terminal';
        appServerState.terminalSeen = true;
        providerTerminalSeen = true;
        if (appServerState.hadError) {
          providerTerminalFailureReason = appServerState.failureReason || 'Codex app-server reported an error';
          providerProtocolErrorPreview = providerTerminalFailureReason;
        }
        try {
          proc.stdin.end();
        } catch {}
        void terminateAfterProviderTerminal(runId, terminateManagedProcess, proc);
      }
    }
    if (claudeBidiState && parsed) {
      await observeClaudePosixCwdResult(claudeBidiState, parsed);
      const handledControlResponse = handleClaudeBidiControlResponse(proc, claudeBidiState, parsed);
      if (handledControlResponse && claudeBidiState.terminalSeen) {
        try {
          proc.stdin.end();
        } catch {}
      }
      if (isClaudeBidiTurnTerminal(parsed)) {
        claudeBidiState.turnActive = false;
        claudeBidiState.steerAwaitingTurnEnd = false;
        claudeBidiState.pendingInterruptRequestId = '';
        claudeBidiState.pendingInterruptReason = '';
        const current = await getRun(runId) || run;
        await flushClaudeBidiSteerQueue(proc, claudeBidiState, current);
        const refreshed = await getRun(runId) || current;
        const hasPendingSteer = Array.isArray(refreshed?.appServerSteerQueue)
          && refreshed.appServerSteerQueue.some((entry) => (
            entry?.state !== 'sent'
            && !claudeBidiState.sentSteerIds.has(typeof entry?.id === 'string' ? entry.id : '')
          ));
        if (!claudeBidiState.turnActive && !hasPendingSteer) {
          if (isClaudeBidiTurnError(parsed) && refreshed?.cancelRequested !== true) {
            claudeBidiState.hadError = true;
            claudeBidiState.failureReason = readStructuredProviderFailureReason(
              parsed,
              'Claude bidirectional runtime reported an error',
            );
          }
          claudeBidiState.terminalSeen = true;
          providerTerminalSeen = true;
          if (claudeBidiState.hadError) {
            providerTerminalFailureReason = claudeBidiState.failureReason || 'Claude bidirectional runtime reported an error';
            providerProtocolErrorPreview = providerTerminalFailureReason;
          }
          try {
            proc.stdin.end();
          } catch {}
          void terminateAfterProviderTerminal(runId, terminateManagedProcess, proc);
        }
      }
    } else {
      await persistProviderRunPatch(runPatch);
    }
  };

  // Provider stdout is an ordered JSON-RPC stream. Processing lines with
  // independent async callbacks lets a later delegated-thread frame observe
  // state before the parent `thread/started` frame has finished persisting it.
  // Serialize the stream so thread correlation and terminal decisions follow
  // provider order, but apply backpressure once the async spool writer falls
  // behind. The old unbounded Promise chain retained every line until the
  // provider stopped and could both exhaust memory and make the watchdog use
  // a stale timestamp.
  let stdoutProcessingPromise = Promise.resolve();
  let providerStdoutInput = null;
  let providerStdoutQueuePaused = false;
  let providerStdoutQueuePauseNoted = false;
  let pendingStdoutLines = 0;
  let pendingStdoutBytes = 0;
  const closedStdoutReaders = new WeakSet();
  let providerErrorPreview = '';
  let stdoutProcessingFailureReason = earlyStdoutError ? `Provider stdout reader failed: ${normalizeErrorMessage(earlyStdoutError)}` : '';
  const stdoutReaderClosePromises = [];
  const stdoutStreamEndPromises = [];
  const trackStdoutReader = (reader, stream) => {
    stdoutReaderClosePromises.push(new Promise((resolveReader) => {
      if (reader.closed) { closedStdoutReaders.add(reader); resolveReader(); return; }
      reader.once('close', () => {
        closedStdoutReaders.add(reader);
        resolveReader();
      });
    }));
    // ChildProcess emits `exit` before its readable stdout stream necessarily
    // reaches EOF. Track the stream itself as a second barrier so a paused
    // readline buffer cannot be mistaken for a drained provider output.
    if (stream?.once) {
      stdoutStreamEndPromises.push(new Promise((resolveStream) => {
        if (stream.readableEnded || stream.destroyed) { resolveStream(); return; }
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolveStream();
        };
        stream.once('end', settle);
        stream.once('close', settle);
        stream.once('error', settle);
      }));
    }
  };
  const controlStdoutReader = (method) => {
    const reader = providerStdoutInput;
    if (!reader || closedStdoutReaders.has(reader)) return;
    try {
      reader[method]?.();
    } catch (error) {
      // A normal provider exit closes readline before the child `exit` handler
      // reaches the drain barrier. Node reports a benign resume/pause-after-
      // close as ERR_USE_AFTER_CLOSE; it must not turn a successful terminal
      // frame into a failed Run.
      if (error?.code !== 'ERR_USE_AFTER_CLOSE') {
        console.error(`[sidecar] Failed to ${method} provider stdout reader for run ${runId}: ${normalizeErrorMessage(error)}`);
      }
    }
  };
  const stdoutQueueMaxLines = readPositiveIntegerEnv(
    'AGENTOC_RUN_STDOUT_QUEUE_MAX_LINES',
    DEFAULT_PROVIDER_STDOUT_QUEUE_MAX_LINES,
  );
  const stdoutQueueMaxBytes = readPositiveIntegerEnv(
    'AGENTOC_RUN_STDOUT_QUEUE_MAX_BYTES',
    DEFAULT_PROVIDER_STDOUT_QUEUE_MAX_BYTES,
  );
  const stdoutLineMaxBytes = readPositiveIntegerEnv(
    'AGENTOC_RUN_STDOUT_LINE_MAX_BYTES',
    DEFAULT_PROVIDER_STDOUT_LINE_MAX_BYTES,
  );
  const stdoutDrainTimeoutMs = readPositiveDurationEnv(
    'AGENTOC_RUN_STDOUT_DRAIN_TIMEOUT_MS',
    DEFAULT_PROVIDER_STDOUT_DRAIN_TIMEOUT_MS,
  );
  const stdoutProcessingTimeoutMs = readPositiveDurationEnv(
    'AGENTOC_RUN_STDOUT_PROCESSING_TIMEOUT_MS',
    Math.max(stdoutDrainTimeoutMs, 20_000),
  );
  const stdoutQueueResumeLines = Math.max(1, Math.floor(stdoutQueueMaxLines / 2));
  const stdoutQueueResumeBytes = Math.max(1, Math.floor(stdoutQueueMaxBytes / 2));
  const pauseProviderStdoutIfNeeded = () => {
    if (providerStdoutQueuePaused) return;
    if (pendingStdoutLines <= stdoutQueueMaxLines && pendingStdoutBytes <= stdoutQueueMaxBytes) return;
    providerStdoutQueuePaused = true;
    controlStdoutReader('pause');
    if (!providerStdoutQueuePauseNoted) {
      providerStdoutQueuePauseNoted = true;
      void logSidecarDiagnostic(runId, 'Provider stdout backpressure engaged; waiting for ordered spool writes', {
        phase: 'provider-stdout-backpressure',
        queuedLines: pendingStdoutLines,
        queuedBytes: pendingStdoutBytes,
        maxLines: stdoutQueueMaxLines,
        maxBytes: stdoutQueueMaxBytes,
      });
    }
  };
  const resumeProviderStdoutIfPossible = () => {
    if (!providerStdoutQueuePaused) return;
    if (pendingStdoutLines > stdoutQueueResumeLines || pendingStdoutBytes > stdoutQueueResumeBytes) return;
    providerStdoutQueuePaused = false;
    controlStdoutReader('resume');
  };
  const enqueueStdoutLine = (line) => {
    // A line is provider activity as soon as readline receives it. This is
    // deliberately outside recordStdoutLine(), whose disk work can lag behind
    // a burst of provider output.
    lastProviderLineAt = Date.now();
    lastOutputAt = lastProviderLineAt;
    providerBytesSeen = true;
    const lineBytes = Buffer.byteLength(String(line || ''), 'utf8');
    if (lineBytes > stdoutLineMaxBytes) {
      const reason = `Provider stdout line exceeded the ${stdoutLineMaxBytes}-byte safety limit`;
      stdoutProcessingFailureReason ||= reason;
      providerProtocolErrorPreview = reason;
      providerErrorPreview = clipDiagnosticMessage(
        `${providerErrorPreview} ${reason}`.trim(),
        2000,
      );
      void logSidecarDiagnostic(runId, reason, {
        phase: 'provider-stdout-line-limit',
        lineBytes,
        maxLineBytes: stdoutLineMaxBytes,
      });
      // Do not enqueue or JSON.parse an oversized frame. Terminate the
      // provider through the existing bounded shutdown path so the Run gets a
      // durable, user-visible failure instead of an OOM or an apparent hang.
      void terminateManagedProcess();
      return stdoutProcessingPromise;
    }
    pendingStdoutLines += 1;
    pendingStdoutBytes += lineBytes;
    pauseProviderStdoutIfNeeded();
    stdoutProcessingPromise = stdoutProcessingPromise
      .then(() => recordStdoutLine(line))
      .catch((error) => {
        const reason = `Failed to process provider stdout: ${normalizeErrorMessage(error)}`;
        stdoutProcessingFailureReason ||= reason;
        providerErrorPreview = clipDiagnosticMessage(
          `${providerErrorPreview} ${reason}`.trim(),
          2000,
        );
        console.error(`[sidecar] ${reason} for run ${runId}`);
        void logSidecarDiagnostic(runId, reason, {
          phase: 'provider-stdout-processing',
          queuedLines: pendingStdoutLines,
          queuedBytes: pendingStdoutBytes,
        });
        // A provider that keeps streaming after the durable spool path has
        // failed can otherwise leave the Run in an apparently live state
        // forever. Fail closed through the same bounded process termination
        // path used for oversized frames and explicit protocol failures.
        void terminateManagedProcess().catch((terminateError) => {
          console.error(`[sidecar] Failed to terminate provider after stdout processing failure for run ${runId}: ${normalizeErrorMessage(terminateError)}`);
        });
      })
      .finally(() => {
        pendingStdoutLines = Math.max(0, pendingStdoutLines - 1);
        pendingStdoutBytes = Math.max(0, pendingStdoutBytes - lineBytes);
        resumeProviderStdoutIfPossible();
      });
    return stdoutProcessingPromise;
  };
  const waitForStdoutProcessing = async () => {
    // The child `exit` event can race readline's final buffered lines. Resume
    // the input first, wait for every reader to observe EOF, then wait until
    // the counters and promise tail settle. Waiting for reader close is
    // essential: a child can exit while its stdout still contains lines that
    // have not yet reached readline's callback.
    controlStdoutReader('resume');
    providerStdoutQueuePaused = false;
    const readerDrain = Promise.all([...stdoutReaderClosePromises, ...stdoutStreamEndPromises]);
    let drainTimedOut = false;
    let drainTimer = null;
    await Promise.race([
      readerDrain,
      new Promise((resolveDrain) => {
        drainTimer = setTimeout(() => {
          drainTimedOut = true;
          resolveDrain();
        }, stdoutDrainTimeoutMs);
        drainTimer.unref?.();
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
    if (drainTimedOut) {
      void logSidecarDiagnostic(runId, 'Provider stdout drain timed out; continuing terminalization', {
        phase: 'provider-stdout-drain-timeout',
        timeoutMs: stdoutDrainTimeoutMs,
        queuedLines: pendingStdoutLines,
        queuedBytes: pendingStdoutBytes,
      }).catch(() => {});
    }
    const waitForProcessingTail = async () => {
      while (pendingStdoutLines > 0) {
        const current = stdoutProcessingPromise;
        await current;
        if (current === stdoutProcessingPromise && pendingStdoutLines === 0) break;
      }
      await stdoutProcessingPromise;
    };
    let processingTimedOut = false;
    let processingTimer = null;
    await Promise.race([
      waitForProcessingTail(),
      new Promise((resolveProcessing) => {
        processingTimer = setTimeout(() => {
          processingTimedOut = true;
          resolveProcessing();
        }, stdoutProcessingTimeoutMs);
        processingTimer.unref?.();
      }),
    ]);
    if (processingTimer) clearTimeout(processingTimer);
    if (processingTimedOut) {
      const reason = `Provider stdout processing timed out after ${stdoutProcessingTimeoutMs}ms`;
      stdoutProcessingFailureReason ||= reason;
      providerProtocolErrorPreview ||= reason;
      void logSidecarDiagnostic(runId, reason, {
        phase: 'provider-stdout-processing-timeout',
        timeoutMs: stdoutProcessingTimeoutMs,
        queuedLines: pendingStdoutLines,
        queuedBytes: pendingStdoutBytes,
      }).catch(() => {});
      // The process may already have exited, but this also covers a provider
      // whose stream is still live while a filesystem operation is wedged.
      void terminateManagedProcess().catch(() => {});
    }
  };

  // A stale resume can make the Codex process close its stdin before the
  // in-process thread/start recovery is consumed. Keep the lifecycle broker's
  // unit alive while a one-shot replacement sidecar starts a fresh thread; the
  // replacement inherits the same Run and durable spool, so no user turn is
  // duplicated and systemd still owns the whole recovery chain.
  const handoffToFreshCodexSidecar = async (currentRun) => {
    if (
      !appServerState?.freshRecoveryRequested
      || currentRun?.cancelRequested === true
      || currentRun?.state === 'completed'
      || currentRun?.state === 'failed'
      || currentRun?.state === 'cancelled'
    ) return false;
    const recoveryStartedAt = nowIso();
    const recoveryPatch = {
      providerRecovery: {
        state: 'starting',
        kind: 'stale_resume',
        attempt: 1,
        startedAt: recoveryStartedAt,
      },
      // Prevent the reconciler from synthesizing a missing-result failure in
      // the short handoff window between the old and replacement sidecars.
      runnerProcessId: null,
      toolProcessId: null,
    };
    const handedRun = await updateRun(runId, (current) => {
      if (!current || current.cancelRequested === true || ['completed', 'failed', 'cancelled'].includes(current.state)) {
        return current;
      }
      return { ...current, ...recoveryPatch };
    });
    if (!handedRun || ['completed', 'failed', 'cancelled'].includes(handedRun.state)) return false;

    let replacement;
    try {
      replacement = await spawnFreshCodexRecoverySidecar({ runId });
    } catch (error) {
      appServerState.hadError = true;
      appServerState.providerStage = 'failed';
      appServerState.failureReason = `Codex fresh-thread recovery sidecar failed to start: ${normalizeErrorMessage(error)}`;
      return false;
    }
    await updateRun(runId, (current) => ({
      ...current,
      providerRecovery: {
        ...recoveryPatch.providerRecovery,
        state: 'running',
        replacementProcessId: replacement.pid || null,
      },
    })).catch(() => null);
    await logSidecarDiagnostic(runId, 'Codex app-server stale resume requires a fresh sidecar; handoff started', {
      phase: 'codex-app-server-stale-resume-handoff',
      replacementProcessId: replacement.pid || null,
    });

    const deadline = Date.now() + CODEX_FRESH_RECOVERY_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(250);
      const next = await getRun(runId);
      if (next && ['completed', 'failed', 'cancelled'].includes(next.state)) return true;
    }
    appServerState.hadError = true;
    appServerState.providerStage = 'failed';
    appServerState.failureReason = 'Codex fresh-thread recovery sidecar did not terminalize the Run before timeout';
    return false;
  };

  const recordStderrText = async (text) => {
    // stderr is diagnostic noise (for example Codex's startup banner), not
    // provider progress. It must not keep a stalled provider alive forever.
    const trimmed = text.trim();
    if (!trimmed) return;
    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean) continue;
      providerErrorPreview = clipDiagnosticMessage(
        `${providerErrorPreview} ${clean}`.trim(),
        2000,
      );
      await appendRunSpoolRecord(runId, {
        ts: nowIso(),
        stream: 'stderr',
        line: clean,
      }, { buffered: true });
    }
  };
  const handleStderrChunk = (chunk) => {
    void recordStderrText(chunk.toString()).catch((error) => {
      const reason = `Failed to process provider stderr: ${normalizeErrorMessage(error)}`;
      stdoutProcessingFailureReason ||= reason;
      providerErrorPreview = clipDiagnosticMessage(
        `${providerErrorPreview} ${reason}`.trim(),
        2000,
      );
      void logSidecarDiagnostic(runId, reason, {
        phase: 'provider-stderr-processing',
      }).catch(() => {});
      void terminateManagedProcess().catch((terminateError) => {
        console.error(`[sidecar] Failed to terminate provider after stderr processing failure for run ${runId}: ${normalizeErrorMessage(terminateError)}`);
      });
    });
  };

  // A provider can close its JSON-RPC stdin immediately after a startup
  // failure. Node reports the resulting EPIPE on the stdin stream rather than
  // on the child process; consume it so the sidecar can preserve the provider
  // diagnosis and let the normal exit/recovery path decide the Run outcome.
  // Any harness can close stdin while the sidecar is still flushing an
  // initial prompt, approval, or steer. Without an error listener Node treats
  // the resulting EPIPE/ERR_STREAM_DESTROYED as an uncaught exception and the
  // Run stops before the normal exit/failure path can persist a result.
  proc.stdin?.on('error', (error) => {
    void logSidecarDiagnostic(
      runId,
      appServerState
        ? 'Codex app-server stdin closed unexpectedly'
        : 'Provider stdin closed unexpectedly',
      {
        code: error?.code || null,
        error: normalizeErrorMessage(error),
        phase: appServerState?.providerStage || runtimeFamily || null,
      },
    );
  });

  const runClaudeClassicFallback = async ({ freshRecovery = false } = {}) => {
    const fallbackPrompt = freshRecovery
      ? freshRecoveryPrompt
      : prompt;
    const fallback = await createToolInvocation('claude', fallbackPrompt, {
      dangerouslySkipPermissions: true,
      ...(freshRecovery ? {} : { claudeSessionId: manifest.options?.claudeSessionId }),
      thinking: manifest.options?.thinking,
      model: manifest.options?.model,
      effort: manifest.options?.effort,
      permissionMode: manifest.options?.permissionMode,
    });
    const fallbackEnv = await cleanEnv('claude', manifest, {
      runtimeFamily: fallback.runtimeFamily,
      envOverrides: fallback.envOverrides,
    });
    // DS-14: line was a pure duplicate of json — readers prefer `json`.
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      json: {
        type: 'status',
          content: freshRecovery
            ? 'Claude resume target was unavailable; restarted this turn from the Ragent continuity checkpoint.'
            : 'Claude Code switched to compatibility mode after bidirectional initialization failed.',
      },
    });
    await updateRun(runId, (current) => ({
      ...current,
      ...(freshRecovery
        ? {
            claudeFreshRecoveryUsed: true,
            claudeFreshRecoveryReason: clipDiagnosticMessage('stale_resume', 200),
            staleClaudeResumeDetected: false,
            staleResumeProvider: null,
          }
        : {
            claudeBidiFallbackUsed: true,
            claudeBidiFallbackReason: clipDiagnosticMessage(claudeBidiState?.failureReason || 'bidi_initialization_failed', 200),
          }),
    }));
    const fallbackSpec = await resolveCommandSpawnSpec(fallback.command, fallback.args, {
      cwd: resolvedFolder.cwd,
      env: fallbackEnv,
    });
    let fallbackCommand = fallbackSpec.file;
    let fallbackArgs = fallbackSpec.args;
    let fallbackShell = fallbackSpec.shell;
    let fallbackVerbatim = fallbackSpec.windowsVerbatimArguments === true;
    let fallbackSandboxDir = null;
    let fallbackProviderSeeds = null;
    if (sandboxRequired) {
      const sandbox = wrapRequiredSandbox(fallbackCommand, fallbackArgs, fallbackEnv);
      fallbackCommand = sandbox.command;
      fallbackArgs = sandbox.args;
      fallbackShell = false;
      fallbackVerbatim = false;
      fallbackSandboxDir = sandbox.emptyDir;
      fallbackProviderSeeds = sandbox.providerSeeds;
    }
    let fallbackJob;
    let fallbackProc;
    let fallbackSeedsDelivered = false;
    try {
      fallbackJob = assertWindowsManagedJob(await createWindowsJobObject());
      if (fallbackJob) {
        if (fallbackShell === true) {
          await fallbackJob.close();
          throw new Error('Windows managed Claude fallback refuses shell:true');
        }
        try {
          await assertRunLaunchBoundary(runId);
          fallbackProc = await fallbackJob.createProcess({
            file: fallbackCommand,
            args: fallbackArgs,
            cwd: resolvedFolder.cwd,
            env: fallbackEnv,
            windowsVerbatimArguments: fallbackVerbatim,
            stdin: true,
            stdout: true,
            stderr: true,
          });
        } catch (error) {
          try { await fallbackJob.terminate(0xC0DE); } catch {}
          await fallbackJob.close();
          throw error;
        }
      } else {
        await assertRunLaunchBoundary(runId);
        fallbackProc = spawn(fallbackCommand, fallbackArgs, {
          cwd: resolvedFolder.cwd,
          stdio: ['pipe', 'pipe', 'pipe', ...(fallbackProviderSeeds?.seeds || []).map(() => 'pipe')],
          env: fallbackEnv,
          shell: fallbackShell,
          windowsVerbatimArguments: fallbackVerbatim,
          ...(process.platform !== 'win32' ? { detached: true } : {}),
        });
      }
      if (fallbackProviderSeeds?.seeds.length) {
        deliverReadOnlyProviderSeeds(fallbackProc, fallbackProviderSeeds);
        fallbackSeedsDelivered = true;
      }
    } catch (error) {
      if (fallbackSandboxDir) { try { rmSync(fallbackSandboxDir, { recursive: true, force: true }); } catch {} }
      throw error;
    } finally {
      if (!fallbackSeedsDelivered) closeReadOnlyProviderSeeds(fallbackProviderSeeds);
    }
    if (fallbackSandboxDir) {
      fallbackProc.once('close', () => {
        try { rmSync(fallbackSandboxDir, { recursive: true, force: true }); } catch {}
      });
    }
    fallbackProc.stdin?.on('error', (error) => {
      void logSidecarDiagnostic(runId, 'Claude compatibility fallback stdin closed unexpectedly', {
        code: error?.code || null,
        error: normalizeErrorMessage(error),
        phase: 'claude-compatibility-fallback',
      });
    });
    try {
      if (fallbackProc.stdin?.writable) fallbackProc.stdin.end(fallbackPrompt);
    } catch (error) {
      terminateProviderProcessTree(fallbackProc, 'SIGTERM');
      await fallbackJob?.close().catch(() => {});
      throw error;
    }
    const fallbackStdoutInput = createInterface({ input: fallbackProc.stdout });
    // The original provider has already exited before this compatibility
    // fallback starts. Make the fallback reader the active backpressure target
    // so a large final response is throttled by the same bounded queue.
    providerStdoutInput = fallbackStdoutInput;
    trackStdoutReader(fallbackStdoutInput, fallbackProc.stdout);
    fallbackProc.stdout?.on('data', (chunk) => {
      if (!chunk || chunk.length === 0) return;
      lastProviderLineAt = Date.now();
      lastOutputAt = lastProviderLineAt;
      providerBytesSeen = true;
    });
    fallbackStdoutInput.on('line', (line) => {
      void enqueueStdoutLine(line);
    });
    fallbackProc.stderr.on('data', handleStderrChunk);
    const fallbackTimeoutMs = readPositiveDurationEnv(
      'AGENTOC_CLAUDE_FALLBACK_TIMEOUT_MS',
      Math.max(idleTimeoutMs, DEFAULT_KNOWN_HARNESS_IDLE_TIMEOUT_MS),
    );
    const fallbackResult = await new Promise((resolveFallback) => {
      let settled = false;
      const finishFallback = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        resolveFallback(result);
      };
      const fallbackTimer = setTimeout(() => {
        terminateProviderProcessTree(fallbackProc, 'SIGTERM');
        const killTimer = setTimeout(() => {
          terminateProviderProcessTree(fallbackProc, 'SIGKILL');
        }, 5000);
        killTimer.unref?.();
        finishFallback({
          code: 1,
          signal: 'SIGTERM',
          error: new Error(`Claude compatibility fallback timed out after ${Math.round(fallbackTimeoutMs / 1000)}s`),
        });
      }, fallbackTimeoutMs);
      fallbackTimer.unref?.();
      fallbackProc.on('error', (error) => finishFallback({ code: 1, signal: null, error }));
      fallbackProc.on('exit', (fallbackCode, fallbackSignal) => finishFallback({
        code: fallbackCode,
        signal: fallbackSignal,
        error: null,
      }));
    });
    // The fallback shares the ordered stdout queue with the original provider.
    // Drain its reader before returning so the caller cannot terminalize the
    // Run while the compatibility provider's final result is still pending.
    await waitForStdoutProcessing();
    await fallbackJob?.close();
    return fallbackResult;
  };

  // Both child-process events run async finalization. Without one shared
  // guard, an `error` followed by `exit` could race and without a rejection
  // boundary any failure in the exit callback (spool I/O, metrics, delegation
  // reconciliation, etc.) left the Run with no result and no user-visible
  // diagnosis. Persist a failed terminal outcome for callback failures unless
  // another path has already durably terminalized the Run.
  let terminalizationInFlight = false;
  const failProviderLifecycleCallback = async (error, phase) => {
    const message = normalizeErrorMessage(error, `Provider lifecycle finalization failed (${phase})`);
    let processExitCode = 1;
    try {
      const current = await getRun(runId);
      if (current && ['completed', 'failed', 'cancelled'].includes(current.state) && current.result) {
        processExitCode = Number.isInteger(current.result.exitCode) ? current.result.exitCode : 0;
      } else {
        await persistRunFailure(runId, new Error(message), {
          cancelled: current?.cancelRequested === true,
          logLabel: 'Detached runner lifecycle finalization failed',
          details: { phase },
        });
      }
    } catch (persistError) {
      console.error(`[sidecar] Failed to persist lifecycle callback failure for run ${runId}: ${normalizeErrorMessage(persistError)}`);
    } finally {
      await waitForApprovedActionResolution(runId).catch(() => {});
      process.exit(processExitCode);
    }
  };

  providerStdoutInput = createInterface({ input: providerStdoutStream });
  // An input error can occur before readline is created. A reader attached
  // to an already destroyed stream will never observe its close event.
  if (providerStdoutStream.destroyed) providerStdoutInput.close();
  trackStdoutReader(providerStdoutInput, providerStdoutStream);
  // A few harnesses stream a JSON/text frame in several chunks before the
  // terminating newline arrives. Treat readable-byte activity as liveness as
  // well as complete readline frames; otherwise the generic watchdog can kill
  // a healthy provider that is actively streaming a large/slow record.
  providerStdoutStream.on('data', (chunk) => {
    if (!chunk || chunk.length === 0) return;
    lastProviderLineAt = Date.now();
    lastOutputAt = lastProviderLineAt;
    providerBytesSeen = true;
  });
  const handleProviderStdoutError = (error) => {
    const reason = `Provider stdout reader failed: ${normalizeErrorMessage(error)}`;
    stdoutProcessingFailureReason ||= reason;
    providerStdoutInput.close();
    providerProtocolErrorPreview = clipDiagnosticMessage(
      `${providerProtocolErrorPreview} ${reason}`.trim(),
      2000,
    );
    void logSidecarDiagnostic(runId, reason, {
      phase: 'provider-stdout-reader',
      code: error?.code || null,
    }).catch(() => {});
    void terminateManagedProcess().catch(() => {});
  };
  providerStdoutInput.on('error', handleProviderStdoutError);
  // readline does not forward errors emitted by its input stream. The
  // buffering stream therefore needs its own handler after setup, too.
  providerStdoutStream.on('error', handleProviderStdoutError);
  if (earlyStdoutError) handleProviderStdoutError(earlyStdoutError);
  providerStdoutInput.on('line', (line) => {
    void enqueueStdoutLine(line);
  });
  const handleProviderStderrError = (error) => {
    const reason = `Provider stderr stream failed: ${normalizeErrorMessage(error)}`;
    stdoutProcessingFailureReason ||= reason;
    void logSidecarDiagnostic(runId, reason, {
      phase: 'provider-stderr-reader',
      code: error?.code || null,
    }).catch(() => {});
    void terminateManagedProcess().catch(() => {});
  };
  providerStderrStream.on('error', handleProviderStderrError);
  if (earlyStderrError) handleProviderStderrError(earlyStderrError);
  providerStderrStream.on('data', handleStderrChunk);
  if (appServerState) {
    if (readOnlyCodexExecutor) {
      configureCodexReadOnlyEnvironment({ proc, state: appServerState, executor: readOnlyCodexExecutor,
        environmentId: `run_${randomUUID().replaceAll('-', '')}`, workspace: readOnlyWorkspace || resolvedFolder.cwd,
        readOnly: Boolean(readOnlyWorkspace), runnerHome: spawnEnv.HOME || '',
        hidePaths: readOnlyCodexHidePaths,
        beforeReady: async () => {
          const { run: latest } = await assertRunLaunchBoundary(runId);
          if (cancelSent || latest.cancelRequested === true || ['completed', 'failed', 'cancelled'].includes(latest.state)) {
            throw new Error('Run stopped during isolated environment setup');
          }
        }, onFailure: () => { void terminateManagedProcess(); } });
    }
    configureCodexAccountModelCatalog({
      proc, state: appServerState,
      beforeReady: async () => {
        const { run: latest } = await assertRunLaunchBoundary(runId);
        if (cancelSent || latest.cancelRequested === true
            || ['completed', 'failed', 'cancelled'].includes(latest.state)) {
          throw Object.assign(new Error('Run stopped during model selection'), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
        }
      },
      onFailure: async (error) => {
        const code = error?.code || 'CODEX_ACCOUNT_MODEL_CATALOG_UNAVAILABLE';
        markCodexAppServerFailure(appServerState, { error: { code, message: error.message } });
        appServerState.terminalSeen = true;
        try {
          await logSidecarDiagnostic(runId, appServerState.failureReason, { phase: 'codex-account-model-catalog', code });
        } finally { await terminateManagedProcess(); }
      },
    });
    writeInitialCodexAppServerMessages(proc, appServerState);
    armCodexAppServerStartupTimeout(
      runId,
      appServerState,
      terminateManagedProcess,
      codexStartupTimeoutMs,
    );
  }
  if (claudeBidiState) {
    writeInitialClaudeBidiMessages(proc, claudeBidiState);
  }
  if (isClaudeFamily && !isClaudeBidiFamily) {
    // Claude print mode reads the prompt from stdin when -p has no argument.
    // This keeps arbitrarily large prompts out of spawn's argv and therefore
    // avoids E2BIG while preserving the existing stream-json stdout contract.
    try {
      proc.stdin.end(typeof initialInput === 'string' ? initialInput : prompt);
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Failed to send Claude prompt through stdin', {
        error: normalizeErrorMessage(error),
      });
      throw error;
    }
  }
  if (isAgyFamily) {
    // AgY 1.1.19 accepts print-mode prompts through its stream-json stdin
    // protocol. Keeping the prompt out of argv avoids ARG_MAX/per-argument
    // limits for long sessions and prevents --print from swallowing a flag.
    try {
      proc.stdin.end(
        typeof initialInput === 'string' ? initialInput : buildAgyStreamInput(prompt),
      );
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Failed to send AgY prompt through stdin', {
        error: normalizeErrorMessage(error),
      });
      throw error;
    }
  }
  if (isPiFamily) {
    // Pi RPC stays alive across turns. Send the first prompt through its
    // JSONL control channel and keep stdin open for future steer/follow-up
    // support; agent_end closes the run below.
    try {
      if (typeof initialInput === 'string' && proc.stdin?.writable) proc.stdin.write(initialInput);
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Failed to send Pi prompt through stdin', {
        error: normalizeErrorMessage(error),
      });
      throw error;
    }
  }
  if (acp === true) {
    try {
      if (!proc.stdin?.writable) throw new Error('ACP stdin is not writable');
      proc.stdin.write(buildAcpStartInput());
      acpState.startupTimer = setTimeout(() => {
        if (acpState.sessionId || proc.exitCode !== null || proc.signalCode !== null) return;
        acpState.hadError = true;
        acpState.failureReason = acpState.sessionStartRequested
          ? 'ACP session start timed out'
          : 'ACP initialization timed out';
        void (async () => {
          try {
            await logSidecarDiagnostic(runId, acpState.failureReason, { phase: 'acp-startup' });
          } finally {
            await terminateManagedProcess();
          }
        })().catch(() => {});
      }, DEFAULT_ACP_STARTUP_TIMEOUT_MS);
      acpState.startupTimer.unref?.();
    } catch (error) {
      await logSidecarDiagnostic(runId, 'Failed to start ACP session', { error: normalizeErrorMessage(error) });
      throw error;
    }
  }

  const handleProcessError = (error) => {
    if (terminalizationInFlight) return;
    terminalizationInFlight = true;
    void (async () => {
      await releaseNativeOAuthLock();
      clearInterval(cancelTimer);
      clearInterval(idleTimer);
      clearTimeout(appServerState?.idleTerminationGraceTimer);
      clearTimeout(appServerState?.startupTimer);
      appServerState?.accountModelCatalog?.cancel();
      clearTimeout(appServerState?.turnRetryTimer);
      clearTimeout(acpState?.startupTimer);
      clearTimeout(acpState?.modeSwitchTimer);
      stopRunnerHeartbeat();
      stopProviderHeartbeat();
      // P1c-4: release the privileged-batch debounce timer alongside the run
      // timers so a late quiescence fire cannot drain into a dead/exiting run.
      // clearTimeout on a cleared/undefined handle is a no-op, and only one
      // runtime state object is ever non-null per run.
      clearTimeout(appServerState?.privilegedBatchTimer);
      clearTimeout(appServerState?.mcpReadinessTimer);
      clearTimeout(appServerState?.mcpStartupFallbackTimer);
      clearTimeout(claudeBidiState?.privilegedBatchTimer);
      await appServerState?.readOnlyEnvironmentSetup?.close();
      await managedMcpOverlay?.cleanup?.();
      await windowsJob?.close();
      await waitForControlFlush();
      await waitForStdoutProcessing();
      await flushPendingClaudeThinkingTokens();
      if (appServerState?.sentSteerIds?.size) {
        await markCodexAppServerSteerSent(runId, [...appServerState.sentSteerIds]);
      }
      if (claudeBidiState?.sentSteerIds?.size) {
        await markClaudeBidiSteerSent(runId, [...claudeBidiState.sentSteerIds]);
      }
      const current = await getRun(runId) || run;
      const failure = appServerState?.idleTerminationReason
        ? new Error(appServerState.idleTerminationReason)
        : error;
      await persistRunFailure(runId, failure, {
        cancelled: current.cancelRequested === true,
        logLabel: 'Detached tool process failed before completion',
        details: {
          phase: 'tool-process-error',
        },
      });
      await waitForApprovedActionResolution(runId);
      // Runs no longer hold a WorkspaceLease; nothing to mark terminal.
      process.exit(1);
    })().catch((callbackError) => failProviderLifecycleCallback(callbackError, 'tool-process-error'));
  };

  const handleProcessExit = (code, signal) => {
    if (terminalizationInFlight) return;
    terminalizationInFlight = true;
    void (async () => {
      await releaseNativeOAuthLock();
      clearInterval(cancelTimer);
      clearInterval(idleTimer);
      clearTimeout(appServerState?.idleTerminationGraceTimer);
      clearTimeout(appServerState?.startupTimer);
      appServerState?.accountModelCatalog?.cancel();
      clearTimeout(appServerState?.turnRetryTimer);
      clearTimeout(acpState?.startupTimer);
      clearTimeout(acpState?.modeSwitchTimer);
      stopProviderHeartbeat();
      // P1c-4: release the privileged-batch debounce timer alongside the run
      // timers so a late quiescence fire cannot drain into a dead/exiting run.
      // clearTimeout on a cleared/undefined handle is a no-op, and only one
      // runtime state object is ever non-null per run.
      clearTimeout(appServerState?.privilegedBatchTimer);
      clearTimeout(appServerState?.mcpReadinessTimer);
      clearTimeout(appServerState?.mcpStartupFallbackTimer);
      clearTimeout(claudeBidiState?.privilegedBatchTimer);
      await appServerState?.readOnlyEnvironmentSetup?.close();
      await managedMcpOverlay?.cleanup?.();
      await windowsJob?.close();
      await waitForControlFlush();
      await waitForStdoutProcessing();
      await flushPendingClaudeThinkingTokens();
      if (appServerState?.sentSteerIds?.size) {
        await markCodexAppServerSteerSent(runId, [...appServerState.sentSteerIds]);
      }
      if (claudeBidiState?.sentSteerIds?.size) {
        await markClaudeBidiSteerSent(runId, [...claudeBidiState.sentSteerIds]);
      }
      let current = await getRun(runId) || run;
      if (appServerState && !appServerState.terminalSeen) {
        // Preserve the protocol phase and the last observable provider output
        // when app-server exits without a correlated terminal frame. The old
        // generic message was technically correct but gave the UI/operator no
        // clue whether the failure happened before initialize, during MCP
        // discovery, after turn/start, or while draining stdout.
        await logSidecarDiagnostic(runId, 'Codex app-server exited without an accepted terminal turn event', {
          phase: appServerState.providerStage || 'unknown',
          exitCode: code ?? null,
          signal: signal || null,
          threadId: appServerState.threadId || null,
          turnId: appServerState.turnId || null,
          lastProviderLineAt: lastProviderLineAt ? new Date(lastProviderLineAt).toISOString() : null,
          providerErrorPreview: providerErrorPreview || null,
          providerProtocolErrorPreview: providerProtocolErrorPreview || null,
        });
      }
      if (appServerState?.freshRecoveryRequested && current.cancelRequested !== true) {
        const handedOff = await handoffToFreshCodexSidecar(current);
        if (handedOff) {
          // The replacement sidecar owns terminalization. This process must
          // not append a stale result over the recovered Run.
          process.exit(0);
          return;
        }
      }
      let terminalCode = code;
      let terminalSignal = signal;
      let fallbackFailureReason = '';
      let fallbackUsed = false;
      if (staleClaudeResumeDetected && current.cancelRequested !== true) {
        try {
          fallbackUsed = true;
          const fallbackResult = await runClaudeClassicFallback({ freshRecovery: true });
          terminalCode = fallbackResult.code;
          terminalSignal = fallbackResult.signal;
          fallbackFailureReason = fallbackResult.error
            ? normalizeErrorMessage(fallbackResult.error, 'Claude fresh recovery failed')
            : '';
          staleClaudeResumeDetected = false;
        } catch (error) {
          terminalCode = 1;
          terminalSignal = null;
          fallbackFailureReason = normalizeErrorMessage(error, 'Claude fresh recovery failed');
        }
      } else if (claudeBidiState && shouldFallbackClaudeBidi(claudeBidiState, current)) {
        try {
          fallbackUsed = true;
          const fallbackResult = await runClaudeClassicFallback();
          terminalCode = fallbackResult.code;
          terminalSignal = fallbackResult.signal;
          fallbackFailureReason = fallbackResult.error
            ? normalizeErrorMessage(fallbackResult.error, 'Claude compatibility runtime failed')
            : '';
          claudeBidiState.hadError = false;
          claudeBidiState.failureReason = '';
        } catch (error) {
          terminalCode = 1;
          terminalSignal = null;
          fallbackFailureReason = normalizeErrorMessage(error, 'Claude compatibility runtime failed');
        }
      }
      const completedAt = nowIso();
      await appendFileChangeStatsSummarySafely(runId, fileChangeStatsTracker);
      await appendCodexContextMetricsSafely(runId, { supportsExternalUsageProjection });
      const controlledWindowsTerminalCleanup = Boolean(windowsJob && proc.__agentocTerminalCleanupRequested === true && terminalCode === 0xC0DE);
      const providerFailureReason = current.cancelRequested === true
        ? ''
        : fallbackFailureReason || (
            stdoutProcessingFailureReason
              ? stdoutProcessingFailureReason
            : appServerState?.idleTerminationReason
              ? appServerState.idleTerminationReason
              : appServerState?.hadError
                ? (appServerState.failureReason || 'Codex app-server reported an error')
              : appServerState && !appServerState.terminalSeen
                ? 'Codex app-server exited before an accepted terminal turn event'
              : claudeBidiState?.hadError
                ? (claudeBidiState.failureReason || 'Claude bidirectional runtime reported an error')
              : acpState?.hadError
                ? (acpState.failureReason || 'ACP runtime reported an error')
              : providerTerminalFailureReason
                ? providerTerminalFailureReason
              : providerNeedsTerminalEvidence && !providerTerminalSeen
                ? (providerProtocolErrorPreview
                  || describeStructuredRuntimeExit(runtimeFamily, providerErrorPreview))
                : (terminalCode !== 0 && !controlledWindowsTerminalCleanup ? providerErrorPreview : '')
          );
      const rawExitCode = terminalCode ?? 1;
      const effectiveExitCode = providerFailureReason
        ? 1
        : (appServerState?.terminalSeen && !appServerState?.hadError && (terminalCode === 0 || terminalSignal === 'SIGTERM' || controlledWindowsTerminalCleanup))
          || (claudeBidiState?.terminalSeen
            && !claudeBidiState?.hadError
            && (current.cancelRequested === true || terminalCode === 0 || terminalSignal === 'SIGTERM' || controlledWindowsTerminalCleanup))
          || (providerNeedsTerminalEvidence
            && providerTerminalSeen
            && (terminalCode === 0 || controlledWindowsTerminalCleanup))
          || (fallbackUsed && terminalCode === 0)
          ? 0
          : rawExitCode;
      // stderr is a diagnostic channel. Providers legitimately use it for
      // recoverable auxiliary failures (for example Codex model-catalog refresh
      // returning 401) and may then complete the requested turn successfully.
      // A successful accepted terminal edge always wins; only a failed outcome
      // may promote the current attempt's error preview into auth recovery.
      const authFailureClass = classifyTerminalRunAuthFailure({
        cancelled: current.cancelRequested === true,
        effectiveExitCode,
        providerFailureReason,
        providerErrorPreview,
      });
      if (authFailureClass === 'auth-expired' && current.cancelRequested !== true) {
        const recovery = await requestLocalRunAuthRecovery({
          manifest,
          failureClass: authFailureClass,
          failureAttempt: normalizeRunAuthAttempt(current),
          sideEffectsConfirmed: false,
        });
        if (recovery.retry === true
            && ['retrying', 'already-retrying'].includes(recovery.status)) {
          // The control plane has either launched the replacement sidecar or
          // already accepted the same request.  This process must not write a
          // stale terminal result after that transition.
          process.exit(0);
          return;
        }
      }
      if (effectiveExitCode === 0 && !providerFailureReason && current.cancelRequested !== true) {
        current = await waitForPrivilegedShimResolution(runId) || current;
      }
      stopRunnerHeartbeat();
      const cancellationCleanupStatus = macCancellationCleanupStatus({
        platform: process.platform,
        brokered: codexAppServerBrokered,
        cancelled: current.cancelRequested === true,
        interruptSent: appServerState?.interruptSent === true,
        observed: appServerState?.macCancellationCleanupStatus,
      });
      if (cancellationCleanupStatus === 'unconfirmed') {
        await appendRunSpoolRecord(runId, {
          ts: nowIso(), stream: 'stdout', json: {
            type: MAC_CLEANUP_SPOOL_TYPE, status: 'unconfirmed',
          },
        });
      }
      const result = {
        completedAt,
        // Persist the effective Run outcome. The old code exposed a provider's
        // clean process exit (often 0) even when the protocol had already
        // failed, which made a failed app-server look successful to recovery.
        exitCode: effectiveExitCode,
        signal: terminalSignal || null,
        cancelled: current.cancelRequested === true,
        ...(cancellationCleanupStatus ? { cancellationCleanupStatus } : {}),
        ...(providerFailureReason && rawExitCode !== effectiveExitCode
          ? { providerExitCode: rawExitCode }
          : {}),
        ...(appServerState?.providerStage ? { providerStage: appServerState.providerStage } : {}),
        ...(appServerState?.providerErrorCode !== null && appServerState?.providerErrorCode !== undefined
          ? { providerErrorCode: appServerState.providerErrorCode }
          : {}),
        ...(providerNeedsTerminalEvidence
          ? {
              providerTerminalSeen,
              ...(providerTerminalFailureReason
                ? { providerTerminalReason: providerTerminalFailureReason }
                : {}),
            }
          : {}),
        ...(providerFailureReason ? { error: providerFailureReason } : {}),
      };
      const terminalAuthRecovery = authFailureClass === 'reauth-required'
        ? {
          ...(current.authRecovery || {}),
          authRetryState: 'reauth_required',
          lastAuthFailureClass: authFailureClass,
        }
        : effectiveExitCode === 0 && current.authRecovery?.authRetryState === 'auth_retrying'
          ? {
            ...(current.authRecovery || {}),
            authRetryState: 'auth_recovered',
          }
          : null;
      await persistRunTerminalState(
        runId,
        result,
        current.cancelRequested
          ? 'cancelled'
          : providerFailureReason
            ? 'failed'
          : effectiveExitCode === 0
            ? 'completed'
            : 'failed',
        {
          ...(cancellationCleanupStatus ? { cancellationCleanupStatus } : {}),
          ...(providerFailureReason
            ? { failureReason: providerFailureReason }
            : effectiveExitCode === 0
              ? { failureReason: '' }
              : {}),
          ...(terminalAuthRecovery ? { authRecovery: terminalAuthRecovery } : {}),
        },
      );
      await waitForApprovedActionResolution(runId);
      await releaseNativeOAuthLock();
      // Runs no longer hold a WorkspaceLease; nothing to mark terminal.
      process.exit(effectiveExitCode);
    })().catch((callbackError) => failProviderLifecycleCallback(callbackError, 'tool-process-exit'));
  };
  dispatchProcessEvent = (type, args) => {
    if (type === 'error') handleProcessError(...args);
    else handleProcessExit(...args);
  };
  if (pendingProcessEvent) dispatchProcessEvent(pendingProcessEvent.type, pendingProcessEvent.args);
}

if (isMainEntry) {
  main().catch((error) => {
    void (async () => {
      try {
        const current = await getRun(runId);
        await persistRunFailure(runId, error, {
          cancelled: current?.cancelRequested === true,
          logLabel: 'Detached runner main() failed before tool completion',
          details: {
            phase: 'main-catch',
            ...(error?.mcpPreparation ? { mcpPreparation: error.mcpPreparation } : {}),
          },
        });
        if (current?.appApiMessageVersion === 1 && ['RESTRICTED_EXECUTION_UNAVAILABLE',
          'RUN_EXECUTION_INPUT_UNAVAILABLE'].includes(error?.code)) {
          await updateRun(runId, { messageFailureCode: error.code });
        }
        await waitForApprovedActionResolution(runId);
      } catch (persistError) {
        console.error(`[sidecar] Failed to persist main failure for run ${runId}: ${normalizeErrorMessage(persistError)}`);
      } finally {
        await releaseNativeOAuthLock();
        // Runs no longer hold a WorkspaceLease; nothing to mark terminal.
        process.exit(1);
      }
    })();
  });
}
