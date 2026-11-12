import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import {
  buildPlatformSpawnSpec,
  resolveExecutableCommandPathAsync,
} from './executable-resolution.mjs';
import { CONFIG_DIR } from './config.mjs';
import { getHarnessAdapterCompatibility, isAdapterCompatible } from '../chat/harness-compatibility.mjs';
import { getHarnessProviderProtocols } from './provider-runtime/harness-bridge.mjs';
import { fetchHarnessPolicy } from './harness-policy-client.mjs';
import { HARNESS_VERSION_CONTRACTS } from './harness-version-catalog.mjs';
import { createHarnessVersionProbeCache } from './harness-version-probe-cache.mjs';
import { HARNESS_ROOT, internalHarnessCommandCandidates, resolveInternalHarnessCommandPath, buildInternalHarnessInstallerEnvironment, harnessInstallationStatePath, usesWindowsServiceHarnessState } from './harness-paths.mjs';
import { assertHarnessFilesMutable, retireHarnessDirectory, removeRetiredHarnessDirectory, scheduleRetiredHarnessCleanup } from './harness-filesystem.mjs';
import {
  PACKAGED_HARNESS_ROOT,
  packagedHarnessCommandPath,
} from './packaged-harness-runtime.mjs';

const execFileAsync = promisify(execFile);
const APPLICATION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS_INSTALL_STATE_FILE = harnessInstallationStatePath(CONFIG_DIR);
const LEGACY_HARNESS_INSTALL_STATE_FILE = join(CONFIG_DIR, 'harness-installations.json');
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BUFFER = 64 * 1024;
const VERSION_PROBE_CACHE_TTL_MS = 30_000;
const HARNESS_LIST_CACHE_TTL_MS = 5_000;
const versionProbeCache = createHarnessVersionProbeCache();
let harnessListCache = null;
let harnessListRefreshPromise = null;
let lastHarnessBackgroundRefreshAt = 0;
const HARNESS_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 30_000;

async function runHarnessInstallerCommand(command, args, options = {}) {
  // npm/corepack ship as .cmd shims on Windows. child_process.execFile cannot
  // execute a batch file directly there (it fails with spawn EINVAL), so use
  // the existing fixed cmd.exe wrapper rather than silently depending on a
  // user's shell or asking the UI to pretend the install started.
  if (process.platform !== 'win32') {
    return execFileAsync(command, args, options);
  }
  const resolved = await resolveExecutableCommandPathAsync(command, {
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
  });
  if (!resolved) throw new Error(`${command} was not found on PATH`);
  const bundledEntrypoint = {
    'npm.cmd': 'node_modules/npm/bin/npm-cli.js',
    'corepack.cmd': 'node_modules/corepack/dist/corepack.js',
  }[basename(resolved).toLowerCase()];
  if (bundledEntrypoint && await stat(join(dirname(resolved), 'node.exe')).then((s) => s.isFile(), () => false)) {
    const entrypoint = join(dirname(resolved), bundledEntrypoint);
    if (!await stat(entrypoint).then((s) => s.isFile(), () => false)) {
      throw new Error(`HARNESS_INSTALLER_RUNTIME_INCOMPLETE: ${entrypoint} is missing. Repair or update the Ragent Windows installation before installing Harnesses.`);
    }
  }
  const spawnSpec = buildPlatformSpawnSpec(resolved, args, {
    cwd: options.cwd,
    env: options.env,
  });
  return execFileAsync(spawnSpec.file, spawnSpec.args, {
    ...options,
    shell: spawnSpec.shell,
    ...(spawnSpec.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
  });
}

// This is an explicit allowlist. The HTTP API accepts only these ids and never
// accepts a package name, executable, or shell fragment from the caller.
const HARNESS_DEFINITIONS = Object.freeze([
  {
    id: 'codex', name: 'Codex', statusKind: 'managed-npm', command: 'codex',
    package: '@openai/codex',
    runtimeFamily: 'codex-app-server-json',
    platforms: ['linux', 'darwin', 'win32'],
    integration: 'native', transport: 'app-server-stdio', installable: true,
  },
  {
    id: 'claude', name: 'Claude Code', statusKind: 'managed-npm', command: 'claude',
    package: '@anthropic-ai/claude-code', runtimeFamily: 'claude-stream-json-bidi',
    platforms: ['linux', 'darwin', 'win32'], integration: 'native', transport: 'bidi-stdio', installable: true,
  },
  {
    id: 'agy', name: 'Antigravity CLI', statusKind: 'official-script', command: 'agy',
    runtimeFamily: 'agy-stream-json', harnessVersion: 'latest', installSpec: 'latest-official-installer', platforms: ['linux', 'darwin', 'win32'],
    integration: 'native', transport: 'stream-json-stdio', installable: true,
    installUrls: {
      unix: 'https://antigravity.google/cli/install.sh',
      win32: 'https://antigravity.google/cli/install.ps1',
    },
  },
  {
    id: 'pi', name: 'Pi', statusKind: 'managed-npm', command: 'pi',
    package: '@earendil-works/pi-coding-agent', runtimeFamily: 'pi-rpc-jsonl',
    platforms: ['linux', 'darwin', 'win32'], integration: 'adapter-planned', transport: 'rpc-jsonl', installable: true,
  },
  {
    id: 'deepseek-harness', name: 'DeepSeek Harness', statusKind: 'managed-npm', command: 'dsh',
    package: '@deepseek-ai/dsh', runtimeFamily: 'deepseek-harness-acp',
    status: 'ready',
    platforms: ['linux', 'darwin', 'win32'], integration: 'adapter-planned', transport: 'headless-cli', installable: true,
  },
  {
    id: 'qwen-code', name: 'Qwen Code', statusKind: 'managed-npm', command: 'qwen',
    package: '@qwen-code/qwen-code', runtimeFamily: 'qwen-code-acp',
    platforms: ['linux', 'darwin', 'win32'], integration: 'adapter-planned', transport: 'acp-stdio', installable: true,
  },
  {
    id: 'opencode', name: 'OpenCode', statusKind: 'managed-npm', command: 'opencode',
    package: 'opencode-ai', runtimeFamily: 'opencode-json',
    platforms: ['linux', 'darwin', 'win32'], integration: 'adapter-planned', transport: 'jsonl-cli', installable: true,
  },
  {
    id: 'kimi-code', name: 'Kimi Code', statusKind: 'managed-npm', command: 'kimi',
    package: '@moonshot-ai/kimi-code', runtimeFamily: 'kimi-code-acp',
    platforms: ['linux', 'darwin', 'win32'], integration: 'headless-adapter', transport: 'acp-stdio', installable: true,
  },
  {
    id: 'goose', name: 'Goose', statusKind: 'official-script', command: 'goose',
    runtimeFamily: 'goose-headless', platforms: ['linux', 'darwin', 'win32'],
    integration: 'adapter-planned', transport: 'headless-cli', installable: true,
    installUrls: {
      unix: 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh',
      win32: 'https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1',
    },
  },
  {
    id: 'openhands', name: 'OpenHands', statusKind: 'managed-npm', command: 'agent-canvas',
    package: '@openhands/agent-canvas',
    runtimeFamily: 'openhands-headless', platforms: ['linux', 'darwin', 'win32'],
    // Agent Canvas launches a UI and an Agent Server; it is not a detached
    // prompt CLI.  The service adapter is intentionally a separate runtime
    // boundary and is not admitted by the local process runner.
    integration: 'service-required', transport: 'http-ws', serviceRuntimeFamily: 'openhands-agent-server',
    installable: true,
  },
  {
    id: 'copilot', name: 'GitHub Copilot', statusKind: 'managed-npm', command: 'copilot',
    package: '@github/copilot',
    runtimeFamily: 'copilot-json', platforms: ['linux', 'darwin', 'win32'],
    integration: 'native', transport: 'jsonl-cli', installable: true,
  },
  {
    id: 'hermes', name: 'Hermes Agent', statusKind: 'official-script', command: 'hermes-acp',
    runtimeFamily: 'hermes-acp',
    platforms: ['linux', 'darwin', 'win32'], integration: 'native', transport: 'acp-stdio', installable: true,
    installArgsUnix: [
      '--commit', HARNESS_VERSION_CONTRACTS.hermes.sourceCommit,
      '--skip-browser', '--skip-computer-use', '--non-interactive',
    ],
    installArgsWin32: [
      '-Commit', HARNESS_VERSION_CONTRACTS.hermes.sourceCommit,
      '-SkipBrowser', '-SkipComputerUse', '-NonInteractive',
    ],
    installUrls: {
      unix: `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HARNESS_VERSION_CONTRACTS.hermes.sourceCommit}/scripts/install.sh`,
      win32: `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HARNESS_VERSION_CONTRACTS.hermes.sourceCommit}/scripts/install.ps1`,
    },
  },
  {
    id: 'cline', name: 'Cline', statusKind: 'managed-npm', command: 'cline',
    package: 'cline',
    runtimeFamily: 'cline-json', platforms: ['linux', 'darwin', 'win32'],
    integration: 'headless-adapter', transport: 'jsonl-cli', installable: true,
  },
  {
    id: 'kilo', name: 'Kilo Code', statusKind: 'managed-npm', command: 'kilo',
    package: '@kilocode/cli',
    runtimeFamily: 'kilo-json', platforms: ['linux', 'darwin', 'win32'],
    integration: 'headless-adapter', transport: 'jsonl-cli', installable: true,
  },
].map((definition) => {
  const version = HARNESS_VERSION_CONTRACTS[definition.id];
  return Object.freeze({ ...definition, harnessVersion: version.targetVersion,
    installSpec: definition.package ? `${definition.package}@${version.targetVersion}`
      : definition.id === 'hermes' ? `official-installer@${version.sourceCommit}`
        : definition.id === 'goose' ? `stable-release-v${version.targetVersion}` : definition.installSpec,
    ...(version.observedVersion ? { observedVersion: version.observedVersion } : {}),
    ...(version.serviceRuntimeVersion ? { serviceRuntimeVersion: version.serviceRuntimeVersion } : {}),
  });
}));

// `kilo-code` was the provisional id used before the official package/command
// was verified. Keep it as an input alias so existing sessions and API callers
// migrate to the canonical `kilo` definition without creating a second tool.
const HARNESS_ID_ALIASES = Object.freeze({ 'kilo-code': 'kilo' });

function canonicalHarnessId(id) {
  const value = String(id || '').trim();
  return HARNESS_ID_ALIASES[value] || value;
}

async function pathsReferToSameFile(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  try {
    const [resolvedLeft, resolvedRight] = await Promise.all([realpath(left), realpath(right)]);
    return process.platform === 'win32'
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// The control and runner services have distinct SIDs. Keep this non-secret
// installation decision in the control-writable, runner-readable harness
// root, and migrate the existing decision before the control server listens.
export async function ensureWindowsServiceHarnessState() {
  if (!usesWindowsServiceHarnessState() || process.env.AGENTOC_WINDOWS_SERVICE_MODE !== '1') return;
  try { await readFile(HARNESS_INSTALL_STATE_FILE); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let previous = '{}\n';
  try { previous = await readFile(LEGACY_HARNESS_INSTALL_STATE_FILE, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parsed = JSON.parse(previous);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid legacy harness installation state');
  await mkdir(dirname(HARNESS_INSTALL_STATE_FILE), { recursive: true });
  try { await writeFile(HARNESS_INSTALL_STATE_FILE, previous, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function readInstallationState() {
  try {
    const parsed = JSON.parse(await readFile(HARNESS_INSTALL_STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Export only sanitized lifecycle metadata to the account-scoped Harness
// presence publisher. Provider credentials and managed filesystem paths never
// cross this boundary.
export async function listHarnessInstallationState() {
  return readInstallationState();
}

async function writeInstallationState(state) {
  await mkdir(dirname(HARNESS_INSTALL_STATE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${HARNESS_INSTALL_STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, HARNESS_INSTALL_STATE_FILE);
}

async function setInstallationState(id, value) {
  const state = await readInstallationState();
  state[id] = {
    ...(state[id] && typeof state[id] === 'object' ? state[id] : {}),
    ...value,
    updatedAt: new Date().toISOString(),
  };
  await writeInstallationState(state);
  return state[id];
}

async function probeHarnessVersion(path, { execFileImpl = execFileAsync } = {}) {
  if (!path) return { version: '', error: '' };
  const cached = versionProbeCache.get(path);
  if (cached && Date.now() - cached.checkedAt < VERSION_PROBE_CACHE_TTL_MS) return cached;
  const probeGeneration = versionProbeCache.generation();
  try {
    const spawnSpec = buildPlatformSpawnSpec(path, ['--version']);
    const result = await execFileImpl(spawnSpec.file, spawnSpec.args, {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: VERSION_PROBE_MAX_BUFFER,
      windowsHide: true,
      shell: spawnSpec.shell,
      ...(spawnSpec.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
    });
    const value = { version: parseHarnessVersion(`${result?.stdout || ''}\n${result?.stderr || ''}`), error: '', checkedAt: Date.now() };
    versionProbeCache.set(path, value, probeGeneration);
    return value;
  } catch (error) {
    const value = { version: '', error: String(error?.message || 'version check failed').slice(0, 240), checkedAt: Date.now() };
    versionProbeCache.set(path, value, probeGeneration);
    return value;
  }
}

function compatibilityStatus(definition, version, probeError) {
  if (!definition.installed || !definition.adapterCompatibility) return 'not-applicable';
  if (!version) return probeError ? 'unknown' : 'unverified';
  return isAdapterCompatible(definition.id, version, definition.adapterCompatibility)
    ? 'compatible'
    : 'incompatible';
}

export function resolveHarnessTargetVersion(definition, effectivePolicy = {}) {
  const policyTargetVersion = String(effectivePolicy.targetVersion || '').trim();
  const policyTargetAccepted = policyTargetVersion === 'latest'
    ? definition.harnessVersion === 'latest'
    : isAdapterCompatible(definition.id, policyTargetVersion, effectivePolicy);
  return policyTargetAccepted ? policyTargetVersion : definition.harnessVersion;
}

export function assertHarnessInstallationVerified(definition, requestedVersion) {
  if (definition.compatibilityStatus !== 'compatible'
      || (requestedVersion !== 'latest' && definition.detectedVersion !== requestedVersion)) {
    throw Object.assign(new Error(`${definition.name} installed version ${definition.detectedVersion || 'unknown'} does not match the supported target ${requestedVersion}`), {
      code: 'HARNESS_INSTALLED_VERSION_UNVERIFIED',
    });
  }
}

async function resolveDefinition(definition, installationState = null, policy = null, { probeVersion = true } = {}) {
  const effectivePolicy = policy?.[definition.id] || {};
  // Accounts may select only a target already admitted by this adapter
  // release. A malformed or ahead-of-adapter central policy cannot turn into
  // an installation command for an unvalidated Harness version.
  const effectiveHarnessVersion = resolveHarnessTargetVersion(definition, effectivePolicy);
  const managedPath = internalHarnessCommandCandidates(definition.id)[0];
  const packagedPath = packagedHarnessCommandPath(definition.command);
  const detectedPath = await resolveInternalHarnessCommandPath(definition.command, { respectInstallationState: false });
  const record = installationState?.[definition.id];
  const commandAvailable = !!detectedPath;
  // A missing record admits an existing owned installation. An explicit
  // uninstall remains authoritative, including for bundled commands.
  const installed = commandAvailable && record?.installed !== false;
  const path = installed ? detectedPath : '';
  const installationSource = installed
    ? (packagedPath && await pathsReferToSameFile(detectedPath, packagedPath) ? 'bundled' : 'managed')
    : null;
  const base = {
    ...definition,
    available: installed,
    installed,
    commandAvailable,
    path: path || null,
    supportedOnPlatform: definition.platforms.includes(process.platform),
    harnessVersion: effectiveHarnessVersion,
    adapterCompatibility: getHarnessAdapterCompatibility(definition.id, effectivePolicy),
    providerProtocols: getHarnessProviderProtocols(definition.id),
    installationSource,
    managedPath,
  };
  const probe = installed && probeVersion
    ? await probeHarnessVersion(path)
    : { version: '', error: '' };
  const compatibility = compatibilityStatus(base, probe.version, probe.error);
  return {
    ...base,
    detectedVersion: probe.version || null,
    versionCheckError: probe.error || null,
    compatibilityStatus: compatibility,
    minimumVersion: base.adapterCompatibility?.minimumVersion || null,
    targetVersion: effectiveHarnessVersion || null,
    ...(installed && !probeVersion ? { versionProbePending: true } : {}),
    upgradeAction: installed && base.installationSource === 'bundled'
      ? 'package-managed'
      : 'upgrade',
  };
}

function parseHarnessVersion(output) {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : '';
}

/**
 * Verify the selected harness before a Run is spawned. Only an installation
 * resolved from the Registry's managed path may be upgraded automatically;
 * an external PATH installation is reported as an actionable incompatibility.
 */
export async function ensureHarnessCompatible(id, { execFileImpl = execFileAsync } = {}) {
  const definition = await getHarnessDefinition(id);
  if (!definition) throw new Error(`Unknown harness "${id}"`);
  if (!definition.available || !definition.adapterCompatibility) return { definition, checked: false };

  let version = '';
  try {
    const spawnSpec = buildPlatformSpawnSpec(definition.path, ['--version']);
    const result = await execFileImpl(spawnSpec.file, spawnSpec.args, {
      timeout: 15_000,
      maxBuffer: VERSION_PROBE_MAX_BUFFER,
      windowsHide: true,
      shell: spawnSpec.shell,
      ...(spawnSpec.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
    });
    version = parseHarnessVersion(`${result?.stdout || ''}\n${result?.stderr || ''}`);
  } catch (error) {
    throw new Error(`${definition.name} version check failed: ${error?.message || String(error)}`);
  }
  if (isAdapterCompatible(definition.id, version, definition.adapterCompatibility)) return { definition, checked: true, version, upgraded: false };
  if (definition.installationSource !== 'managed') {
    if (definition.installationSource === 'bundled') {
      throw new Error(`${definition.name} ${version || 'unknown version'} is outside this Ragent adapter's validated range; update the Ragent package to target ${definition.harnessVersion}`);
    }
    throw new Error(`${definition.name} ${version || 'unknown version'} is outside this Ragent adapter's validated range; update the Ragent installation`);
  }
  const upgraded = await upgradeHarness(definition.id, definition.harnessVersion);
  return { definition: upgraded, checked: true, version, upgraded: true };
}

export function invalidateHarnessListCache() {
  harnessListCache = null;
  lastHarnessBackgroundRefreshAt = 0;
}

async function buildHarnessList({ probeVersion = true, fetchPolicy = true } = {}) {
  const installationState = await readInstallationState();
  const policy = fetchPolicy ? (await fetchHarnessPolicy()).policies : null;
  return Promise.all(HARNESS_DEFINITIONS.map((definition) => resolveDefinition(
    definition,
    installationState,
    policy,
    { probeVersion },
  )));
}

export function refreshHarnessListInBackground() {
  const now = Date.now();
  if (!harnessListRefreshPromise && now - lastHarnessBackgroundRefreshAt < HARNESS_BACKGROUND_REFRESH_MIN_INTERVAL_MS) {
    return Promise.resolve(harnessListCache?.value || []);
  }
  if (harnessListRefreshPromise) return harnessListRefreshPromise;
  lastHarnessBackgroundRefreshAt = now;
  harnessListRefreshPromise = (async () => {
    try {
      const value = await buildHarnessList({ probeVersion: true, fetchPolicy: true });
      harnessListCache = { checkedAt: Date.now(), value, probeVersion: true };
      return value;
    } catch (error) {
      console.warn(`[harness-registry] background refresh failed: ${error?.message || error}`);
      return harnessListCache?.value || [];
    } finally {
      harnessListRefreshPromise = null;
    }
  })();
  if (typeof harnessListRefreshPromise.catch === 'function') harnessListRefreshPromise.catch(() => {});
  return harnessListRefreshPromise;
}

export async function listHarnesses({ force = false, fast = false } = {}) {
  scheduleRetiredHarnessCleanup(HARNESS_ROOT, HARNESS_DEFINITIONS.map(entry => entry.id));
  if (!force && harnessListCache && Date.now() - harnessListCache.checkedAt < HARNESS_LIST_CACHE_TTL_MS
    && (fast || harnessListCache.probeVersion === true)) {
    if (fast) refreshHarnessListInBackground();
    return harnessListCache.value;
  }
  if (fast && !force) {
    const value = await buildHarnessList({ probeVersion: false, fetchPolicy: false });
    harnessListCache = { checkedAt: Date.now(), value, probeVersion: false };
    refreshHarnessListInBackground();
    return value;
  }
  const value = await buildHarnessList({ probeVersion: true, fetchPolicy: true });
  harnessListCache = { checkedAt: Date.now(), value, probeVersion: true };
  return value;
}

export async function getHarnessDefinition(id, { probeVersion = true } = {}) {
  const definition = HARNESS_DEFINITIONS.find((entry) => entry.id === canonicalHarnessId(id));
  if (!definition) return null;
  const policy = (await fetchHarnessPolicy()).policies;
  return resolveDefinition(definition, await readInstallationState(), policy, { probeVersion });
}

async function installHarnessInternal(id, { version = '', upgrade = false } = {}) {
  const definition = await getHarnessDefinition(id);
  if (!definition) throw new Error('Unknown harness');
  if (!definition.supportedOnPlatform) throw new Error(`Harness is not supported on ${process.platform}`);
  if (!definition.installable) {
    throw new Error(`Harness "${definition.id}" requires manual installation`);
  }
  const requestedVersion = String(version || definition.harnessVersion || '').trim();
  const officialLatestChannel = requestedVersion === 'latest' && definition.harnessVersion === 'latest';
  if (!officialLatestChannel && !isAdapterCompatible(definition.id, requestedVersion)) {
    throw new Error(`Harness "${definition.id}" version "${requestedVersion}" is not compatible with its adapter`);
  }
  if (definition.id === 'hermes' && requestedVersion !== HARNESS_VERSION_CONTRACTS.hermes.targetVersion) {
    throw new Error('Hermes installation must match its pinned source commit and target version');
  }
  if (upgrade && !definition.installSpec) {
    throw new Error(`Harness "${definition.id}" has no update source registered`);
  }
  if (definition.available && !upgrade) return { ...definition, installed: true, alreadyAvailable: true };
  await assertHarnessFilesMutable(join(HARNESS_ROOT, definition.id), definition.name);
  // A managed update may replace the executable at the same path. Do not let
  // the short UI probe cache report the version that was present before npm
  // completed.
  versionProbeCache.invalidate();

  if (definition.statusKind === 'official-script') {
    const installRoot = join(HARNESS_ROOT, definition.id);
    const installerEnv = buildInternalHarnessInstallerEnvironment(definition.id, requestedVersion);
    await Promise.all([mkdir(join(installRoot, 'bin'), { recursive: true }), mkdir(installerEnv.LOCALAPPDATA, { recursive: true }), mkdir(installerEnv.APPDATA, { recursive: true })]);
    const url = process.platform === 'win32'
      ? definition.installUrls?.win32
      : definition.installUrls?.unix;
    const tempRoot = await mkdtemp(join(tmpdir(), 'agentoc-harness-'));
    const script = join(tempRoot, process.platform === 'win32' ? 'install.ps1' : 'install.sh');
    try {
      const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
      await execFileAsync(curl, ['--fail', '--silent', '--show-error', '--location', url, '--output', script], {
        timeout: 5 * 60 * 1000, maxBuffer: 256 * 1024, windowsHide: true,
      });
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
          ...(Array.isArray(definition.installArgsWin32) ? definition.installArgsWin32 : []),
          ...(definition.id === 'agy' ? ['--dir', join(installRoot, 'bin')] : []),
          ...(definition.id === 'hermes' ? ['-HermesHome', installerEnv.HERMES_HOME, '-InstallDir', join(installRoot, 'app')] : []),
        ], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, cwd: installRoot, env: installerEnv });
      } else {
        await chmod(script, 0o700);
        await execFileAsync('bash', [script, ...(Array.isArray(definition.installArgsUnix) ? definition.installArgsUnix : []),
          ...(definition.id === 'agy' ? ['--dir', join(installRoot, 'bin')] : []),
          ...(definition.id === 'hermes' ? ['--dir', join(installRoot, 'app')] : []),
        ], {
          // The script uses --commit/-Commit as its only version pin. Keep
          // every installer argument in the immutable definition above.
          timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, cwd: installRoot, env: installerEnv,
        });
      }
    } catch (error) {
      const detail = String(error?.stderr || error?.message || 'official installer failed').trim().slice(-1200);
      throw new Error(`Failed to install ${definition.name}: ${detail}`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (!await resolveInternalHarnessCommandPath(definition.command, { respectInstallationState: false })) {
      throw new Error(`${definition.name} installer did not publish its command inside the Ragent Harness directory`);
    }
    versionProbeCache.invalidate();
    await setInstallationState(definition.id, { installed: true, version: requestedVersion });
    invalidateHarnessListCache();
    const result = await getHarnessDefinition(definition.id);
    if (!result.available) throw new Error(`${definition.name} internal runtime is unavailable after installation`);
    assertHarnessInstallationVerified(result, requestedVersion);
    return { ...result, installed: true, alreadyAvailable: false };
  }

  if (definition.statusKind !== 'managed-npm') {
    throw new Error(`Harness "${definition.id}" requires manual installation`);
  }

  const installDir = join(HARNESS_ROOT, definition.id);
  await mkdir(installDir, { recursive: true, mode: 0o755 });
  const npm = String(process.env.AGENTOC_NPM_COMMAND || '').trim()
    || (process.platform === 'win32' ? join(APPLICATION_ROOT, 'npm.cmd') : 'npm');
  try {
    const packageSpec = definition.statusKind === 'managed-npm'
      ? `${definition.package}@${requestedVersion}`
      : (definition.installSpec || definition.package);
    // dsh publishes a large, tightly-versioned workspace graph. pnpm resolves
    // its peer graph without npm's pathological memory spike; retain npm for
    // the other managed harnesses.
    if (definition.id === 'deepseek-harness') {
      const corepack = process.platform === 'win32' ? join(dirname(npm), 'corepack.cmd') : 'corepack';
      await runHarnessInstallerCommand(corepack, ['pnpm', 'add', '--dir', installDir, '--lockfile=false', '--ignore-scripts', packageSpec], {
        timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
    } else {
      await runHarnessInstallerCommand(npm, [
        'install', '--prefix', installDir, '--no-save', '--package-lock=false', packageSpec,
      ], { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || 'npm install failed').trim().slice(-1200);
    throw new Error(`Failed to install ${definition.name}: ${detail}`);
  }

  // First installs have no initial path to invalidate. Discard probes launched
  // against partially extracted files before checking the finished runtime.
  versionProbeCache.invalidate();
  await setInstallationState(definition.id, { installed: true, version: requestedVersion });
  invalidateHarnessListCache();
  const result = await getHarnessDefinition(definition.id);
  if (!result.available) throw new Error(`${definition.name} installed but its command was not found`);
  assertHarnessInstallationVerified(result, requestedVersion);
  return { ...result, installed: true, upgraded: upgrade, alreadyAvailable: false };
}

let harnessMutationQueue = Promise.resolve();

function queueHarnessMutation(task) {
  const run = harnessMutationQueue.then(task, task);
  harnessMutationQueue = run.catch(() => {});
  return run;
}

export async function installHarness(id, options = {}) {
  return queueHarnessMutation(() => installHarnessInternal(id, options));
}

export async function upgradeHarness(id, version) {
  return installHarness(id, { version, upgrade: true });
}

export async function uninstallHarness(id) {
  return queueHarnessMutation(async () => {
    // Do not launch a version probe immediately before deleting its runtime.
    const definition = await getHarnessDefinition(id, { probeVersion: false });
    if (!definition) throw new Error('Unknown harness');
    if (!definition.supportedOnPlatform) throw new Error(`Harness is not supported on ${process.platform}`);
    versionProbeCache.invalidate();

    let cleanup = { filesRemoved: false, cleanupPending: false };
    const previous = (await readInstallationState())[definition.id];
    await assertHarnessFilesMutable(join(HARNESS_ROOT, definition.id), definition.name);
    // Disable new resolution before moving files. If the atomic move fails,
    // restore only this Harness's prior decision and preserve its live tree.
    await setInstallationState(definition.id, { installed: false, version: definition.harnessVersion || '' });
    if (['managed-npm', 'official-script'].includes(definition.statusKind)) {
      // The id is selected from the immutable allowlist above.  Never remove
      // a command discovered on PATH or accept a caller-supplied filesystem
      // path as an uninstall target.
      let retiredPath;
      try {
        retiredPath = await retireHarnessDirectory(HARNESS_ROOT, definition.id, definition.name);
      } catch (error) {
        const state = await readInstallationState();
        if (previous === undefined) delete state[definition.id];
        else state[definition.id] = previous;
        await writeInstallationState(state);
        invalidateHarnessListCache();
        throw error;
      }
      cleanup = await removeRetiredHarnessDirectory(retiredPath);
    }
    invalidateHarnessListCache();
    const result = await getHarnessDefinition(definition.id);
    return {
      ...result,
      uninstalled: true,
      ...cleanup,
      dataPreserved: true,
      manualCleanupRequired: false,
    };
  });
}

export { HARNESS_ROOT, HARNESS_INSTALL_STATE_FILE, PACKAGED_HARNESS_ROOT };
