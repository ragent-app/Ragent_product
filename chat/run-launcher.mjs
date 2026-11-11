import { execFile as execFileCallback, spawn as spawnProcess } from 'child_process';
import { WORKBENCH_EXECUTION_POLICY, assertWorkbenchExecution } from '../lib/workbench-execution-policy.mjs';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { connect as connectSocket } from 'net';
import { homedir } from 'os';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import {
  CHAT_PORT,
  CHAT_RUNS_DIR,
  CLAUDE_MANAGED_HOME_DIR,
  CODEX_MANAGED_HOME_DIR,
  CONFIG_DIR,
} from '../lib/config.mjs';
import { parseScopedCodexModel } from './models.mjs';
import { getRunManifest, updateRun, updateRunManifest } from './runs.mjs';
import { normalizeRunAuthRecovery } from '../lib/provider-runtime/run-auth-recovery.mjs';
import {
  pickRunnerEnvAllowlist,
  pickRunnerGuiEnvironment,
  stripDeniedRunnerEnvKeys,
} from '../lib/runner-env.mjs';
import { resolveRunnerProxyEnvironment } from '../lib/network-proxy.mjs';
import { serializeUserShellEnvSnapshot, userShellEnv } from '../lib/user-shell-env.mjs';
import { ensureHarnessCompatible } from '../lib/harness-registry.mjs';
import { assertRunLaunchBoundary, assertRunManifestExecutionBoundary } from './run-execution-boundary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerEntry = join(__dirname, 'runner-sidecar.mjs');
const execFileAsync = promisify(execFileCallback);
const SYSTEMD_MAIN_PID_RETRIES = 8;
const SYSTEMD_MAIN_PID_RETRY_DELAY_MS = 50;

export const DETACHED_RUNNER_PROCESS_LAUNCH_MODE = 'detached-process';
export const DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE = 'systemd-transient-service';
export const DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE = 'runner-supervisor';
// The lifecycle broker owns one transient systemd unit per Run.  Keeping this
// as a distinct mode lets the reconciler distinguish the new cgroup contract
// from legacy supervisor children during a rolling upgrade.
export const DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE = 'runner-lifecycle';
const RUNNER_LIFECYCLE_TIMEOUT_MS = Number.parseInt(
  process.env.AGENTOC_RUNNER_LIFECYCLE_TIMEOUT_MS || '120000',
  10,
);
export const PROVIDER_PREPARATION_MAX_ATTEMPTS = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSystemdMainPid(value) {
  const pid = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function sanitizeSystemdUnitFragment(value) {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9:_.@-]+/g, '_');
  return normalized || 'unknown';
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function prependWindowsHarnessBinDirs(environment) {
  if (process.platform !== 'win32') return environment;
  const harnessRoot = trimString(environment?.AGENTOC_HARNESS_ROOT);
  if (!harnessRoot) return environment;
  const currentPath = trimString(environment?.PATH);
  const entries = [
    join(harnessRoot, 'codex', 'node_modules', '.bin'),
    join(harnessRoot, 'claude', 'node_modules', '.bin'),
    currentPath,
  ].filter(Boolean);
  const seen = new Set();
  return {
    ...environment,
    PATH: entries.filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join(delimiter),
  };
}

function safePreparationCode(value, fallback = '') {
  const normalized = trimString(value);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(normalized) ? normalized : fallback;
}

function providerPreparationGuidance(app, causeCode) {
  const label = ({ codex: 'Codex', claude: 'Claude', agy: 'AgY' })[trimString(app)] || 'Agent';
  switch (safePreparationCode(causeCode).toLowerCase()) {
    case 'native-provider-not-selected':
      return `No ${label} provider is configured on this computer. Open Ragent Settings > Providers, add or select a ${label} provider, then retry.`;
    case 'credential-missing':
      return `The selected ${label} provider has no usable credential on this computer. Reconnect or replace its credential in Ragent Settings > Providers, then retry.`;
    case 'provider-disabled':
      return `The selected ${label} provider is disabled on this computer. Enable it in Ragent Settings > Providers, then retry.`;
    case 'provider-not-ready':
      return `The selected ${label} provider is not ready on this computer. Complete its setup in Ragent Settings > Providers, then retry.`;
    default:
      return '';
  }
}

export function providerPreparationEvidence({
  state,
  stage,
  attempt = 1,
  maxAttempts = PROVIDER_PREPARATION_MAX_ATTEMPTS,
  errorCode = '',
  causeCode = '',
  providerId = '',
  app = '',
  startedAt = null,
  finishedAt = null,
} = {}) {
  return {
    state,
    stage: safePreparationCode(stage, 'provider-home'),
    attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
    maxAttempts: Number.isSafeInteger(maxAttempts) && maxAttempts > 0
      ? maxAttempts : PROVIDER_PREPARATION_MAX_ATTEMPTS,
    ...(safePreparationCode(errorCode) ? { errorCode: safePreparationCode(errorCode) } : {}),
    ...(safePreparationCode(causeCode) ? { causeCode: safePreparationCode(causeCode) } : {}),
    ...(trimString(providerId) ? { providerId: trimString(providerId) } : {}),
    ...(trimString(app) ? { app: trimString(app) } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  };
}

export async function persistProviderPreparation(runId, preparation) {
  await updateRun(runId, (current) => ({
    ...current,
    providerPreparation: preparation,
  }), { preserveOwner: true }).catch(() => null);
}

export function createProviderPreparationError(message, {
  app,
  providerId,
  stage = 'provider-home',
  causeCode = '',
  sourceError = null,
  startedAt = null,
} = {}) {
  const error = sourceError instanceof Error ? sourceError : new Error(message);
  const sourceCode = safePreparationCode(error.code);
  const errorCode = /^(?:PROVIDER_HOME_|MCP_)/.test(sourceCode)
    ? sourceCode
    : 'PROVIDER_HOME_PREPARE_FAILED';
  const normalizedCauseCode = safePreparationCode(
    causeCode || error.causeCode || (sourceCode !== errorCode ? sourceCode : ''),
  );
  // Keep credentials and provider configuration private while making the
  // common setup failures actionable for a remote phone user.
  error.message = providerPreparationGuidance(app, normalizedCauseCode) || message;
  error.code = errorCode;
  error.stage = safePreparationCode(stage, 'provider-home');
  if (normalizedCauseCode) error.causeCode = normalizedCauseCode;
  error.providerPreparation = providerPreparationEvidence({
    state: 'failed',
    stage,
    attempt: Number.isSafeInteger(error.attempt) ? error.attempt : 1,
    maxAttempts: Number.isSafeInteger(error.maxAttempts)
      ? error.maxAttempts : PROVIDER_PREPARATION_MAX_ATTEMPTS,
    errorCode,
    causeCode: normalizedCauseCode,
    providerId,
    app,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  return error;
}

function resolveRunnerGuiEnvironment() {
  return pickRunnerGuiEnvironment({ ...userShellEnv, ...process.env });
}

export function resolveProviderHomesDir(providerHomesDir, app, providerId) {
  const baseDir = trimString(providerHomesDir);
  const normalizedApp = trimString(app).toLowerCase();
  const normalizedProviderId = trimString(providerId);
  if (!baseDir || !normalizedProviderId) return baseDir;
  const providerKey = createHash('sha256')
    .update(`${normalizedApp}:${normalizedProviderId}`)
    .digest('hex')
    .slice(0, 32);
  return join(baseDir, 'by-provider', providerKey);
}

export function resolveCodexProviderHomesDir(providerHomesDir, providerId) {
  return resolveProviderHomesDir(providerHomesDir, 'codex', providerId);
}

export function resolveRunProviderSelection(manifest) {
  const runtimeFamily = trimString(manifest?.options?.runtimeFamily || manifest?.runtimeFamily);
  const tool = trimString(manifest?.tool);
  // Only built-in provider tools own the managed provider homes. Custom tools
  // may intentionally reuse a provider-shaped runtime family (for example a
  // deterministic codex-json test double) without having provider state to
  // synchronize.
  const isClaude = tool === 'claude' || tool === 'claude-bidi';
  const isCodex = tool === 'codex' || tool === 'codex-cli';
  const isAgy = tool === 'agy' || runtimeFamily === 'agy-json' || runtimeFamily === 'agy-stream-json';
  const genericApp = {
    'pi-rpc-jsonl': 'pi', 'qwen-code-acp': 'qwen-code',
    'opencode-json': 'opencode', 'kimi-code-acp': 'kimi-code',
    'goose-headless': 'goose', 'openhands-headless': 'openhands',
    'copilot-json': 'copilot', 'hermes-acp': 'hermes',
  }[runtimeFamily] || '';
  const explicitProfile = trimString(manifest?.options?.providerProfile);
  // Native-mode claude model ids carry the same `model@providerId` suffix as
  // codex ones (chat/models.mjs emits them per provider profile); the suffix
  // must contribute to provider selection here but never reach the CLI's
  // --model flag (resolveClaudeRuntimeModelAlias strips it at spawn).
  const modelProviderId = (isCodex || isClaude || isAgy)
    ? parseScopedCodexModel(trimString(manifest?.options?.model)).providerId
    : '';
  return {
    app: isClaude ? 'claude' : (isCodex ? 'codex' : (isAgy ? 'agy' : genericApp)),
    providerId: explicitProfile || modelProviderId,
    runtimeFamily,
  };
}

export async function prepareDetachedRunnerProvider(runId, {
  environment = process.env,
  runnerReadable = false,
  readManifestImpl = getRunManifest,
  prepareNativeImpl = null,
} = {}) {
  const manifest = await readManifestImpl(runId);
  if (!manifest) return { environment, manifest: null, app: '', providerId: '' };
  assertRunManifestExecutionBoundary(manifest);
  if (manifest.options?.temporaryControlAuthority) await assertRunLaunchBoundary(runId);
  const selection = resolveRunProviderSelection(manifest);
  if (WORKBENCH_EXECUTION_POLICY) {
    assertWorkbenchExecution({ agentType: selection.app || manifest.tool || '',
      model: manifest.options?.model || WORKBENCH_EXECUTION_POLICY.model,
      ...(selection.providerId ? { providerProfileId: selection.providerId } : {}) });
  }
  const runtimeFamily = trimString(manifest?.options?.runtimeFamily || manifest?.runtimeFamily);
  if (!selection.app) return { environment, manifest, ...selection };

  try {
    await ensureHarnessCompatible(selection.app);
  } catch (error) {
    const preparedError = createProviderPreparationError(
      `${selection.app} harness is incompatible with the Ragent adapter`,
      {
        app: selection.app,
        providerId: selection.providerId,
        stage: 'harness-compatibility',
        causeCode: 'HARNESS_INCOMPATIBLE',
        sourceError: error,
      },
    );
    await persistProviderPreparation(runId, preparedError.providerPreparation);
    throw preparedError;
  }

  const startedAt = new Date().toISOString();
  await persistProviderPreparation(runId, providerPreparationEvidence({
    state: 'preparing',
    stage: 'provider-home',
    attempt: 1,
    maxAttempts: PROVIDER_PREPARATION_MAX_ATTEMPTS,
    providerId: selection.providerId,
    app: selection.app,
    startedAt,
  }));

  const providerHomesDir = trimString(environment.AGENTOC_PROVIDER_HOMES_DIR)
    || dirname(selection.app === 'codex' ? CODEX_MANAGED_HOME_DIR : CLAUDE_MANAGED_HOME_DIR);
  const { prepareNativeRunProviderHome } = await import('../lib/provider-runtime/run-provider-prepare.mjs');
  let nativeResult = null;
  try {
    nativeResult = await (prepareNativeImpl || prepareNativeRunProviderHome)(runId, manifest, {
      configDir: trimString(environment.AGENTOC_NATIVE_REGISTRY_DIR)
        || trimString(environment.AGENTOC_CONFIG_DIR)
        || CONFIG_DIR,
      providerHomesRoot: providerHomesDir,
      externalCodexAuthFile: trimString(environment.AGENTOC_EXTERNAL_CODEX_AUTH_FILE)
        || (trimString(environment.AGENTOC_EXTERNAL_CODEX_HOME)
          ? join(trimString(environment.AGENTOC_EXTERNAL_CODEX_HOME), 'auth.json')
          : join(homedir(), '.codex', 'auth.json')),
      // Codex OAuth is machine-local. Do not let a launcher environment flag
      // opt a Run back into the user's ~/.codex refresh-token chain.
      externalOAuthOwnership: false,
      // The sidecar no longer holds this lock for ordinary Codex Runs. It
      // connects to the machine-local app-server broker instead, allowing
      // independent threads on the same account to run concurrently.
      holdNativeOAuthLock: false,
      forceRunScopedHome: manifest.executionScope?.accessMode === 'read',
      runnerReadable,
    });
    if (nativeResult?.ok !== true) {
      throw createProviderPreparationError(
        `Native ${selection.app} provider preparation failed (${selection.providerId || 'unselected'})`,
        {
          app: selection.app,
          providerId: selection.providerId,
          stage: 'provider-home',
          causeCode: nativeResult?.reason,
          startedAt,
        },
      );
    }
  } catch (error) {
    try { await nativeResult?.oauthLock?.release?.(); } catch {}
    const preparedError = createProviderPreparationError(
      `Native ${selection.app} provider preparation failed (${selection.providerId || 'unselected'})`,
      {
        app: selection.app,
        providerId: selection.providerId,
        stage: error?.stage || 'provider-home',
        causeCode: error?.causeCode || error?.reason || '',
        sourceError: error,
        startedAt,
      },
    );
    await persistProviderPreparation(runId, preparedError.providerPreparation);
    throw preparedError;
  }
  if (nativeResult?.snapshot) {
    const snapshot = nativeResult.snapshot;
    await updateRunManifest(runId, (current) => ({
      ...current,
      nativeRuntimeSnapshot: snapshot,
    })).catch(() => null);
    if (Number.isSafeInteger(snapshot.credentialVersion)
        || trimString(snapshot.credentialInstanceId)) {
      await updateRun(runId, (current) => {
        if (!current) return current;
        const existing = current.authRecovery
          ? normalizeRunAuthRecovery(current.authRecovery)
          : null;
        const recovery = existing || normalizeRunAuthRecovery({});
        const next = {
          ...recovery,
          ...(recovery.authCredentialVersion === null
            && Number.isSafeInteger(snapshot.credentialVersion)
            ? { authCredentialVersion: snapshot.credentialVersion }
            : {}),
          ...(recovery.credentialInstanceId || !trimString(snapshot.credentialInstanceId)
            ? {}
            : { credentialInstanceId: trimString(snapshot.credentialInstanceId) }),
          ...(recovery.resumeId
            ? {}
            : {
              resumeId: trimString(
                current.codexThreadId
                  || current.claudeSessionId
                  || current.agyConversationId
                  || current.providerResumeId,
              ),
            }),
        };
        if (JSON.stringify(existing || null) === JSON.stringify(next)) return current;
        return { ...current, authRecovery: next };
      }).catch(() => null);
    }
  }
  if (!nativeResult.providerId) {
    await nativeResult?.oauthLock?.release?.();
    await persistProviderPreparation(runId, providerPreparationEvidence({
      state: 'ready',
      stage: 'verified',
      providerId: selection.providerId,
      app: selection.app,
      startedAt,
      finishedAt: new Date().toISOString(),
    }));
    return { environment, manifest, ...selection };
  }
  await persistProviderPreparation(runId, providerPreparationEvidence({
    state: 'ready',
    stage: 'verified',
    attempt: nativeResult.preparation?.attempt || 1,
    maxAttempts: nativeResult.preparation?.maxAttempts || PROVIDER_PREPARATION_MAX_ATTEMPTS,
    providerId: nativeResult.providerId,
    app: selection.app,
    startedAt,
    finishedAt: new Date().toISOString(),
  }));
  return {
    manifest,
    app: selection.app,
    providerId: nativeResult.providerId,
    providerHomesDir: nativeResult.homeDir,
    environment: {
      ...environment,
      AGENTOC_PROVIDER_HOMES_DIR: nativeResult.homeDir,
      ...(selection.app === 'codex'
        ? { AGENTOC_CODEX_HOME_DIR: trimString(nativeResult.codexHomeDir) }
        : {}),
      ...(selection.app === 'agy'
        ? { AGENTOC_AGY_HOME_DIR: trimString(nativeResult.agyHomeDir) }
        : {}),
      ...(nativeResult.providerId
        ? { AGENTOC_PROVIDER_PROFILE_ID: nativeResult.providerId }
        : {}),
      ...(nativeResult.oauthLock?.path && nativeResult.oauthLock?.token
        ? {
          AGENTOC_NATIVE_OAUTH_LOCK_PATH: nativeResult.oauthLock.path,
          AGENTOC_NATIVE_OAUTH_LOCK_TOKEN: nativeResult.oauthLock.token,
        }
        : {}),
      ...(selection.app === 'codex' && nativeResult.snapshot?.serviceTier
        ? { AGENTOC_CODEX_SERVICE_TIER: nativeResult.snapshot.serviceTier }
        : {}),
    },
    nativeRuntimeSnapshot: nativeResult.snapshot || null,
  };
}

export function buildDetachedRunnerUnitName(runId, { launchAttempt = 0 } = {}) {
  const normalizedAttempt = Number.isSafeInteger(Number(launchAttempt)) && Number(launchAttempt) > 0
    ? Math.floor(Number(launchAttempt))
    : 0;
  return `agentoc-runner-${sanitizeSystemdUnitFragment(runId)}${normalizedAttempt > 0 ? `-a${normalizedAttempt}` : ''}`;
}

export function detectSystemdManagerScope(cgroupText) {
  const text = String(cgroupText || '');
  if (/(^|\n)\d+::\/system\.slice\/[^\n]+\.service(?:\n|$)/.test(text)) {
    return 'system';
  }
  if (/(^|\n)\d+::\/user\.slice\/.*\/[^\n]+\.service(?:\n|$)/.test(text)) {
    return 'user';
  }
  return null;
}

export function getCurrentSystemdManagerScope({
  platform = process.platform,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (platform !== 'linux') return null;
  try {
    return detectSystemdManagerScope(readFileSyncImpl('/proc/self/cgroup', 'utf8'));
  } catch {
    return null;
  }
}

export function shouldUseSystemdDetachedRunner({
  platform = process.platform,
  env = process.env,
  scope = getCurrentSystemdManagerScope({ platform }),
} = {}) {
  return platform === 'linux'
    && env?.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER !== '1'
    && (scope === 'system' || scope === 'user');
}

export function buildDetachedRunnerEnvironment({
  launchMode,
  unitName = null,
  unitScope = null,
  proxyEnv = {},
} = {}) {
  const sandboxMode = String(process.env.IS_SANDBOX || '').trim();
  const projectRoot = process.env.AGENTOC_PROJECT_ROOT || join(__dirname, '..');
  // Bounded test-injection channel: integration tests toggle deterministic
  // sidecar behavior (synthetic pre-spawn failure, finalization-metrics throw)
  // via AGENTOC_TEST_* keys, which the shared allowlist would otherwise strip.
  // The strip gate below still removes deny-listed and credential-shaped keys
  // (e.g. AGENTOC_TEST_TOKEN), so this cannot smuggle config or secrets into a
  // Run.  In production the control plane never sets AGENTOC_TEST_*, so this
  // is a no-op there.
  const testOverrides = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AGENTOC_TEST_') && value !== undefined && value !== null) {
      testOverrides[key] = value;
    }
  }
  // Explicit allowlist inheritance: only the shared runner allowlist keys are
  // copied from process.env, plus the explicit overrides below.  The second
  // strip gate guarantees production config/socket/credential keys can never
  // reach the Run even if they are introduced by an override.
  const env = prependWindowsHarnessBinDirs(stripDeniedRunnerEnvKeys({
    ...pickRunnerEnvAllowlist(process.env),
    ...resolveRunnerGuiEnvironment(),
    ...proxyEnv,
    ...testOverrides,
    // HOME is on the shared allowlist but is always overridden here so it
    // matches the OS user the sidecar will actually run as, never a stale
    // value from the caller's environment.  os.homedir() resolves the home of
    // the current process — the supervisor daemon runs as agentoc-runner and
    // the plain-process fallback runs as the control user — so HOME is correct
    // in both paths.
    HOME: homedir(),
    AGENTOC_CHAT_BASE_URL: `http://127.0.0.1:${CHAT_PORT}`,
    AGENTOC_PROJECT_ROOT: projectRoot,
    // Controlled spool write-back channel: the sidecar writes run results to
    // the control plane's chat-runs directory without being told the
    // production AGENTOC_CONFIG_DIR.
    AGENTOC_RUN_SPOOL_DIR: CHAT_RUNS_DIR,
    AGENTOC_USER_SHELL_ENV_B64: serializeUserShellEnvSnapshot(),
    AGENTOC_RUNNER_LAUNCH_MODE: launchMode || DETACHED_RUNNER_PROCESS_LAUNCH_MODE,
    ...(unitName ? { AGENTOC_RUNNER_UNIT_NAME: unitName } : {}),
    ...(unitScope ? { AGENTOC_RUNNER_UNIT_SCOPE: unitScope } : {}),
    ...(sandboxMode ? {} : { IS_SANDBOX: '1' }),
  }));
  return env;
}

function normalizeSupervisorSocketPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function shouldUseRunnerSupervisor({ env = process.env } = {}) {
  return !!normalizeSupervisorSocketPath(env?.AGENTOC_RUNNER_SUPERVISOR_SOCKET);
}

export function shouldUseRunnerLifecycleBroker({ env = process.env } = {}) {
  return !!normalizeSupervisorSocketPath(env?.AGENTOC_RUNNER_LIFECYCLE_SOCKET);
}

export function isWindowsManagedRunnerPlatform(platform = process.platform) {
  return platform === 'win32';
}

export async function launchDetachedRunnerViaLifecycleBroker(runId, {
  socketPath = process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET,
  connectImpl = connectSocket,
  launchAttempt = 0,
  timeoutMs = Number.isFinite(RUNNER_LIFECYCLE_TIMEOUT_MS) && RUNNER_LIFECYCLE_TIMEOUT_MS > 0
    ? RUNNER_LIFECYCLE_TIMEOUT_MS : 120_000,
} = {}) {
  const normalizedSocketPath = normalizeSupervisorSocketPath(socketPath);
  if (!normalizedSocketPath) {
    throw new Error('Runner lifecycle broker socket is not configured');
  }
  const guiEnvironment = resolveRunnerGuiEnvironment();
  const unavailableError = (message) => {
    const error = new Error(message);
    error.code = 'RUNNER_BROKER_UNAVAILABLE';
    return error;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = connectImpl(normalizedSocketPath);
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(unavailableError(`Runner lifecycle broker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        type: 'launch',
        runId,
        launchAttempt: Number.isSafeInteger(Number(launchAttempt)) && Number(launchAttempt) >= 0
          ? Math.floor(Number(launchAttempt))
          : 0,
        ...(Object.keys(guiEnvironment).length > 0 ? { guiEnvironment } : {}),
      })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newlineIndex));
      } catch (error) {
        finish(unavailableError(`Invalid runner lifecycle response: ${error.message}`));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error || 'Runner lifecycle broker rejected launch request');
        error.code = response?.code || 'RUNNER_LAUNCH_REJECTED';
        finish(error);
        return;
      }
      finish(null, {
        pid: Number.isInteger(response.pid) && response.pid > 0 ? response.pid : null,
        unitName: response.unitName || null,
        unitScope: response.unitScope || 'system',
        supervisorSocket: null,
        launchMode: DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
        launchAttempt: Number.isSafeInteger(response.launchAttempt) ? response.launchAttempt : 0,
      });
    });
    socket.once('error', (error) => {
      error.code = 'RUNNER_BROKER_UNAVAILABLE';
      finish(error);
    });
    socket.once('end', () => {
      if (!settled) finish(unavailableError('Runner lifecycle broker closed without a response'));
    });
  });
}

// On managed Windows installations the supervisor's public pipe is owned by
// the SCM service host. Its native client verifies the actual pipe server PID
// against SCM before transmitting the run-bound request or OAuth lock token.
export function exchangeWindowsSupervisorRequest(request, { timeoutMs = 30000, spawnImpl = spawnProcess,
  executable = join(dirname(process.execPath), '..', 'AgentoC.ServiceHost.exe') } = {}) {
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > 16384) return Promise.reject(new Error('Runner supervisor request is too large'));
  return new Promise((resolve, reject) => {
    let child, settled = false, output = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child?.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Runner supervisor timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    try { child = spawnImpl(executable, ['--runner-supervisor-pipe'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(new Error('Runner supervisor native client is unavailable')); return; }
    child.once('error', () => finish(new Error('Runner supervisor native client is unavailable')));
    child.stdin.once('error', () => finish(new Error('Runner supervisor native client is unavailable')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output, 'utf8') > 16384) finish(new Error('Runner supervisor response is too large')); });
    child.once('close', code => {
      if (code !== 0) { finish(new Error('Runner supervisor native client rejected the connection')); return; }
      try {
        const response = JSON.parse(output.trim());
        if (!response?.ok) { const error = new Error(response?.error || 'Runner supervisor rejected launch request'); if (typeof response?.code === 'string') error.code = response.code; throw error; }
        finish(null, response);
      } catch (error) { finish(error); }
    });
    child.stdin.end(encoded);
  });
}

export async function launchDetachedRunnerViaSupervisor(runId, {
  socketPath = process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET,
  connectImpl = connectSocket,
  timeoutMs = Number.parseInt(process.env.AGENTOC_RUNNER_SUPERVISOR_TIMEOUT_MS || '30000', 10),
  prepareProviderImpl = prepareDetachedRunnerProvider,
} = {}) {
  const normalizedSocketPath = normalizeSupervisorSocketPath(socketPath);
  if (!normalizedSocketPath) {
    throw new Error('Runner supervisor socket is not configured');
  }

  const proxyEnv = await resolveRunnerProxyEnvironment();
  const baseEnv = buildDetachedRunnerEnvironment({
    launchMode: DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
    proxyEnv,
  });
  const prepared = await prepareProviderImpl(runId, {
    environment: baseEnv,
    runnerReadable: true,
  });
  const providerHomesDir = trimString(prepared?.providerId)
    ? trimString(prepared?.providerHomesDir)
    : '';

  let oauthLockHandedOff = false;
  try {
    const request = {
      type: 'launch', runId,
      ...(providerHomesDir ? { providerHomesDir } : {}),
      ...(prepared?.oauthLock?.path && prepared?.oauthLock?.token ? { oauthLockPath: prepared.oauthLock.path, oauthLockToken: prepared.oauthLock.token } : {}),
    };
    const managedWindows = process.platform === 'win32' && process.env.AGENTOC_WINDOWS_SERVICE_MODE === '1'
      && process.env.AGENTOC_WINDOWS_SERVICE_ROLE === 'control' && connectImpl === connectSocket;
    let result;
    if (managedWindows) {
      if (normalizedSocketPath.toLowerCase() !== '\\\\.\\pipe\\agentoc-runner-supervisor-owner') throw new Error('Runner supervisor pipe is not the installed endpoint');
      const response = await exchangeWindowsSupervisorRequest(request, { timeoutMs });
      result = { pid: Number.isInteger(response.pid) && response.pid > 0 ? response.pid : null,
        unitName: null, unitScope: null, supervisorSocket: normalizedSocketPath, launchMode: DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE };
    } else result = await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = connectImpl(normalizedSocketPath);
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Runner supervisor timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newlineIndex));
      } catch (error) {
        finish(new Error(`Invalid runner supervisor response: ${error.message}`));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error || 'Runner supervisor rejected launch request');
        if (typeof response?.code === 'string') error.code = response.code;
        finish(error);
        return;
      }
      finish(null, {
        pid: Number.isInteger(response.pid) && response.pid > 0 ? response.pid : null,
        unitName: null,
        unitScope: null,
        supervisorSocket: normalizedSocketPath,
        launchMode: DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
      });
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(new Error('Runner supervisor closed without a response'));
    });
    });
    oauthLockHandedOff = true;
    return result;
  } finally {
    if (!oauthLockHandedOff) {
      try { await prepared?.oauthLock?.release?.(); } catch {}
    }
  }
}

function appendSystemdEnvironmentArgs(args, env) {
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value === undefined || value === null) continue;
    const normalized = String(value);
    if (normalized.includes('\0')) continue;
    args.push('--setenv', `${key}=${normalized}`);
  }
}

function buildSystemctlArgs(scope, ...args) {
  return scope === 'user'
    ? ['--user', ...args]
    : args;
}

function buildSystemdRunArgs(scope, ...args) {
  return scope === 'user'
    ? ['--user', ...args]
    : args;
}

export async function readSystemdUnitMainPid(unitName, {
  scope = 'system',
  execFileImpl = execFileAsync,
  retries = SYSTEMD_MAIN_PID_RETRIES,
  retryDelayMs = SYSTEMD_MAIN_PID_RETRY_DELAY_MS,
} = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(
        'systemctl',
        buildSystemctlArgs(scope, 'show', '--property=MainPID', '--value', unitName),
        { timeout: 2_000, maxBuffer: 128 * 1024 },
      );
      const pid = parseSystemdMainPid(stdout);
      if (pid) {
        return pid;
      }
    } catch {
      // Retry a few times while systemd populates the transient unit metadata.
    }
    if (attempt < (retries - 1)) {
      await sleep(retryDelayMs);
    }
  }
  return null;
}

export async function launchDetachedRunnerViaSystemd(runId, {
  scope = getCurrentSystemdManagerScope(),
  execFileImpl = execFileAsync,
  unitName = buildDetachedRunnerUnitName(runId),
  workingDirectory = process.cwd(),
  processExecPath = process.execPath,
  runnerScriptPath = runnerEntry,
  prepareProviderImpl = prepareDetachedRunnerProvider,
} = {}) {
  const launchMode = DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE;
  const proxyEnv = await resolveRunnerProxyEnvironment();
  const baseEnv = buildDetachedRunnerEnvironment({ launchMode, unitName, unitScope: scope, proxyEnv });
  const prepared = await prepareProviderImpl(runId, { environment: baseEnv });
  const env = prepared?.environment || baseEnv;
  const args = [
    ...buildSystemdRunArgs(scope),
    '--quiet',
    '--collect',
    '--no-block',
    '--service-type=exec',
    '--unit',
    unitName,
    '--working-directory',
    workingDirectory,
    '--description',
    `AgentoC detached runner ${runId}`,
  ];
  appendSystemdEnvironmentArgs(args, env);
  args.push(processExecPath, runnerScriptPath, runId);
  let oauthLockHandedOff = false;
  try {
    await execFileImpl('systemd-run', args, {
      env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    oauthLockHandedOff = true;
    const pid = await readSystemdUnitMainPid(unitName, { scope, execFileImpl });
    return {
      pid,
      unitName,
      unitScope: scope,
      launchMode,
    };
  } finally {
    if (!oauthLockHandedOff) {
      try { await prepared?.oauthLock?.release?.(); } catch {}
    }
  }
}

export async function spawnDetachedRunnerAsProcess(runId, {
  spawnImpl = spawnProcess,
  processExecPath = process.execPath,
  runnerScriptPath = runnerEntry,
  prepareProviderImpl = prepareDetachedRunnerProvider,
} = {}) {
  const launchMode = DETACHED_RUNNER_PROCESS_LAUNCH_MODE;
  const proxyEnv = await resolveRunnerProxyEnvironment();
  const baseEnv = buildDetachedRunnerEnvironment({ launchMode, proxyEnv });
  const prepared = await prepareProviderImpl(runId, { environment: baseEnv });
  const env = prepared?.environment || baseEnv;
  let oauthLockHandedOff = false;
  try {
    const child = spawnImpl(processExecPath, [runnerScriptPath, runId], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref?.();
    oauthLockHandedOff = true;
    return {
      pid: child.pid ?? null,
      unitName: null,
      unitScope: null,
      launchMode,
    };
  } finally {
    if (!oauthLockHandedOff) {
      try { await prepared?.oauthLock?.release?.(); } catch {}
    }
  }
}

export function createDetachedRunnerSpawner({
  execFileImpl = execFileAsync,
  spawnImpl = spawnProcess,
  getScopeImpl = getCurrentSystemdManagerScope,
  connectImpl = connectSocket,
  platform = process.platform,
  assertExecutionBoundaryImpl = assertRunLaunchBoundary,
} = {}) {
  return async function spawnDetachedRunner(runId, { launchAttempt = 0 } = {}) {
    // All launch strategies, including lifecycle and legacy fallbacks, share
    // this gate before preparing credentials or contacting a broker.
    await assertExecutionBoundaryImpl(runId);
    if (shouldUseRunnerLifecycleBroker()) {
      try {
        return await launchDetachedRunnerViaLifecycleBroker(runId, { connectImpl, launchAttempt });
      } catch (error) {
        // These are authoritative safety refusals, not transport outages.
        // Retrying through another launcher could bypass identity checks or
        // start a second copy while a previous unit is still draining.
        if (['RUNNER_IDENTITY_INVALID', 'RUNNER_UNIT_STATUS_UNAVAILABLE', 'RUNNER_UNIT_DRAINING'].includes(error?.code)) throw error;
        if (process.env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED === '1') {
          if (error?.code !== 'RUNNER_BROKER_UNAVAILABLE') throw error;
          const unavailable = new Error(`Required runner lifecycle broker is unavailable: ${error?.message || String(error)}`);
          unavailable.code = 'RUNNER_BROKER_UNAVAILABLE';
          throw unavailable;
        }
        console.error(`[runs] Failed to launch runner via lifecycle broker: ${error?.message || String(error)}; trying legacy launch strategies.`);
      }
    }
    if (shouldUseRunnerSupervisor()) {
      try {
        return await launchDetachedRunnerViaSupervisor(runId, { connectImpl });
      } catch (error) {
        if (error?.code === 'WINDOWS_EXECUTION_IDENTITY_UNSAFE'
            || error?.code === 'WINDOWS_EXECUTION_IDENTITY_UNAVAILABLE') throw error;
        if (process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED === '1'
          || isWindowsManagedRunnerPlatform(platform)) {
          throw new Error(`Required runner supervisor is unavailable: ${error?.message || String(error)}`);
        }
        console.error(`[runs] Failed to launch detached runner ${runId} via runner supervisor: ${error?.message || String(error)}; trying legacy launch strategies.`);
      }
    }
    if (isWindowsManagedRunnerPlatform(platform)) {
      throw new Error(
        'Windows managed runner requires an available runner lifecycle or supervisor broker; refusing detached-process fallback',
      );
    }
    const scope = getScopeImpl();
    if (shouldUseSystemdDetachedRunner({ scope })) {
      try {
        return await launchDetachedRunnerViaSystemd(runId, { scope, execFileImpl });
      } catch (error) {
        console.error(`[runs] Failed to launch detached runner ${runId} via systemd-run (${scope}): ${error?.message || String(error)}; falling back to plain detached process.`);
      }
    }
    return spawnDetachedRunnerAsProcess(runId, { spawnImpl });
  };
}

export const spawnDetachedRunner = createDetachedRunnerSpawner();
