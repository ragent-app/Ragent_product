/**
 * Read-only Windows per-user runtime diagnostics.
 *
 * This module intentionally does not import the config module or create any
 * directory. It resolves the same path family as startup, loads the durable
 * identity without creating it, and derives the named-pipe endpoint only when
 * that identity already exists. Credential inspection is lstat/readdir-only:
 * no secret file is opened and no credential value is returned.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

import { loadInstanceIdentity } from './instance-identity.mjs';
import { buildPlatformSpawnSpec } from './executable-resolution.mjs';
import {
  deriveWindowsEndpointName,
  resolveWindowsPerUserPaths,
  resolveWindowsServicePaths,
} from './windows-runtime-paths.mjs';

export const WINDOWS_RUNTIME_DIAGNOSTICS_VERSION = 'windows-runtime-diagnostics/v1';
export const WINDOWS_RUNTIME_DIAGNOSTIC_SCOPES = Object.freeze(['user', 'service']);
const execFileAsync = promisify(execFileCallback);
const WINDOWS_PROVIDER_COMMANDS = Object.freeze(['claude', 'codex', 'agy', 'cline']);
const WINDOWS_SERVICE_NAMES = Object.freeze([
  'Ragent-RunnerSupervisor',
  'Ragent-ControlPlane',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function errorCode(error, fallback = 'WINDOWS_DIAGNOSTICS_UNAVAILABLE') {
  return trimString(error?.code) || fallback;
}

function fileType(info) {
  if (info?.isFile?.()) return 'file';
  if (info?.isDirectory?.()) return 'directory';
  if (info?.isSymbolicLink?.()) return 'symlink';
  return 'other';
}

export async function describeWindowsFileMetadata(filePath, { lstatImpl = lstat } = {}) {
  const path = trimString(filePath);
  if (!path) return Object.freeze({ path: '', exists: false, type: 'missing' });
  try {
    const info = await lstatImpl(path);
    return Object.freeze({ path, exists: true, type: fileType(info) });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ path, exists: false, type: 'missing' });
    return Object.freeze({ path, exists: false, type: 'unavailable', code: errorCode(error) });
  }
}

function directoryEntryType(entry) {
  if (entry?.isFile?.()) return 'file';
  if (entry?.isDirectory?.()) return 'directory';
  if (entry?.isSymbolicLink?.()) return 'symlink';
  return 'other';
}

async function describeSecretEntries(secretDirectory, {
  directoryMetadata,
  readdirImpl = readdir,
} = {}) {
  if (directoryMetadata.type !== 'directory') return [];
  try {
    const entries = await readdirImpl(secretDirectory, { withFileTypes: true });
    return entries
      .map((entry) => ({
        name: trimString(entry?.name),
        type: directoryEntryType(entry),
      }))
      .filter((entry) => entry.name)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    return [{ name: '', type: 'unavailable', code: errorCode(error) }];
  }
}

function diagnosticError(error) {
  return {
    code: errorCode(error),
    message: trimString(error?.message) || 'Windows runtime diagnostics failed',
  };
}

function firstOutputLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => trimString(line))
    .find(Boolean) || '';
}

function outputLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => trimString(line))
    .filter(Boolean);
}

function normalizeDiagnosticScope(scope) {
  const normalized = trimString(scope).toLowerCase() || 'user';
  if (!WINDOWS_RUNTIME_DIAGNOSTIC_SCOPES.includes(normalized)) {
    const error = new Error(`Unknown Windows diagnostics scope '${scope}'. Use user or service.`);
    error.code = 'WINDOWS_DIAGNOSTICS_SCOPE_INVALID';
    throw error;
  }
  return normalized;
}

export function buildWindowsRuntimeServiceProbePowerShell() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$names = @('Ragent-RunnerSupervisor', 'Ragent-ControlPlane')",
    '$services = @{}',
    '$missing = @()',
    'foreach ($name in $names) {',
    '  $service = Get-Service -Name $name -ErrorAction SilentlyContinue',
    '  if (-not $service) { $missing += $name; continue }',
    '  $services[$name] = $service.Status.ToString()',
    '}',
    '[pscustomobject]@{ installed = ($missing.Count -eq 0); missing = $missing; states = $services } | ConvertTo-Json -Compress',
  ].join('\n');
}

/**
 * Resolve and version one Windows executable without invoking a shell. The
 * result contains no environment values or command output beyond one version
 * line, which keeps doctor output safe to share in a support report.
 */
export async function describeWindowsExecutable(command, {
  lookupCommand = 'where.exe',
  versionArgs = ['--version'],
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  const name = trimString(command);
  if (!name) return Object.freeze({ name: '', status: 'invalid' });

  let executablePaths = [name];
  if (lookupCommand) {
    try {
      const result = await execFileImpl(lookupCommand, [name], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      executablePaths = outputLines(result?.stdout);
      if (executablePaths.length === 0) {
        return Object.freeze({ name, status: 'missing', code: 'WINDOWS_EXECUTABLE_NOT_FOUND' });
      }
    } catch (error) {
      return Object.freeze({ name, status: 'missing', code: errorCode(error, 'WINDOWS_EXECUTABLE_NOT_FOUND') });
    }
  }

  let lastError = null;
  for (const executablePath of executablePaths) {
    try {
      const spawnSpec = buildPlatformSpawnSpec(executablePath, versionArgs, {
        env,
      });
      const result = await execFileImpl(spawnSpec.file, spawnSpec.args, {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        ...(spawnSpec.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      });
      const version = firstOutputLine(result?.stdout) || firstOutputLine(result?.stderr);
      return Object.freeze({
        name,
        path: executablePath,
        status: 'ready',
        ...(version ? { version } : {}),
      });
    } catch (error) {
      lastError = error;
    }
  }
  return Object.freeze({
    name,
    path: executablePaths[0],
    status: 'unavailable',
    code: errorCode(lastError),
  });
}

async function collectWindowsToolDiagnostics({ env, execFileImpl }) {
  const powershellPath = trimString(env?.RAGENT_POWERSHELL) || 'powershell.exe';
  const [node, powershell, git, ...providers] = await Promise.all([
    describeWindowsExecutable(process.execPath, { lookupCommand: null, env, execFileImpl }),
    describeWindowsExecutable(powershellPath, {
      lookupCommand: null,
      versionArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      env,
      execFileImpl,
    }),
    describeWindowsExecutable('git.exe', { env, execFileImpl }),
    ...WINDOWS_PROVIDER_COMMANDS.map((command) => describeWindowsExecutable(command, { env, execFileImpl })),
  ]);
  return {
    node,
    powershell,
    git,
    providers: Object.fromEntries(WINDOWS_PROVIDER_COMMANDS.map((command, index) => [command, providers[index]])),
  };
}

async function collectWindowsServiceDiagnostics({ env, execFileImpl }) {
  const powershellPath = trimString(env?.RAGENT_POWERSHELL) || 'powershell.exe';
  let result;
  try {
    result = await execFileImpl(powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      buildWindowsRuntimeServiceProbePowerShell(),
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    return {
      status: 'unavailable',
      code: errorCode(error),
    };
  }

  let report;
  try {
    report = JSON.parse(String(result?.stdout || '').trim());
  } catch (error) {
    return {
      status: 'unavailable',
      code: 'WINDOWS_SERVICE_REPORT_INVALID',
      error: diagnosticError(error),
    };
  }

  const states = {};
  for (const name of WINDOWS_SERVICE_NAMES) {
    const state = trimString(report?.states?.[name]);
    if (state) states[name] = state;
  }
  const reportedMissing = new Set(
    Array.isArray(report?.missing)
      ? report.missing.map((name) => trimString(name)).filter((name) => WINDOWS_SERVICE_NAMES.includes(name))
      : [],
  );
  const missing = WINDOWS_SERVICE_NAMES.filter((name) => reportedMissing.has(name) || !states[name]);
  const installed = report?.installed === true && missing.length === 0;
  const running = installed && WINDOWS_SERVICE_NAMES.every(
    (name) => states[name].toLowerCase() === 'running',
  );
  return {
    status: running ? 'ready' : (missing.length > 0 || !installed ? 'missing' : 'degraded'),
    installed,
    states,
    ...(missing.length > 0 ? { missing } : {}),
  };
}

/**
 * Collect local Windows runtime facts without any startup mutation.
 * `identityLoader` is injectable for contract tests and must have the same
 * read-only behavior as loadInstanceIdentity.
 */
export async function collectWindowsRuntimeDiagnostics({
  platform = process.platform,
  env = process.env,
  scope = 'user',
  paths: suppliedPaths,
  identityLoader = loadInstanceIdentity,
  lstatImpl = lstat,
  readdirImpl = readdir,
  execFileImpl = execFileAsync,
} = {}) {
  let normalizedScope;
  try {
    normalizedScope = normalizeDiagnosticScope(scope);
  } catch (error) {
    return Object.freeze({
      version: WINDOWS_RUNTIME_DIAGNOSTICS_VERSION,
      platform,
      supported: platform === 'win32',
      status: 'invalid',
      error: diagnosticError(error),
    });
  }
  if (platform !== 'win32') {
    return Object.freeze({
      version: WINDOWS_RUNTIME_DIAGNOSTICS_VERSION,
      platform,
      supported: false,
      status: 'unsupported',
      scope: normalizedScope,
      code: 'WINDOWS_RUNTIME_PLATFORM_REQUIRED',
    });
  }

  let paths;
  try {
    paths = suppliedPaths || (normalizedScope === 'service'
      ? resolveWindowsServicePaths({ platform, env })
      : resolveWindowsPerUserPaths({ platform, env }));
  } catch (error) {
    return Object.freeze({
      version: WINDOWS_RUNTIME_DIAGNOSTICS_VERSION,
      platform,
      supported: true,
      status: 'invalid',
      scope: normalizedScope,
      error: diagnosticError(error),
    });
  }

  const secretDirectory = win32.join(paths.configDir, 'native-provider-runtime', 'secrets');
  const files = {
    auth: await describeWindowsFileMetadata(win32.join(paths.configDir, 'auth.json'), { lstatImpl }),
    identity: await describeWindowsFileMetadata(paths.instanceIdentityFile, { lstatImpl }),
    ownership: await describeWindowsFileMetadata(paths.ownershipFile, { lstatImpl }),
    secretsDirectory: await describeWindowsFileMetadata(secretDirectory, { lstatImpl }),
  };
  files.secretEntries = await describeSecretEntries(secretDirectory, {
    directoryMetadata: files.secretsDirectory,
    readdirImpl,
  });

  let identity = null;
  let identityState = 'missing';
  let identityError = null;
  try {
    identity = await identityLoader({ filePath: paths.instanceIdentityFile });
    identityState = identity ? 'loaded' : 'missing';
  } catch (error) {
    identityState = 'invalid';
    identityError = diagnosticError(error);
  }

  let endpoint;
  if (identityState === 'loaded' && trimString(identity?.instanceId)) {
    try {
      endpoint = {
        status: 'derived',
        transport: 'named-pipe',
        name: deriveWindowsEndpointName({
          instanceRoot: paths.instanceRoot,
          instanceId: identity.instanceId,
          allowProgramData: normalizedScope === 'service',
        }),
      };
    } catch (error) {
      endpoint = { status: 'unavailable', reason: 'identity-invalid', error: diagnosticError(error) };
    }
  } else {
    endpoint = {
      status: 'unavailable',
      reason: identityState === 'missing' ? 'instance-identity-missing' : 'instance-identity-invalid',
    };
  }

  const services = normalizedScope === 'service'
    ? await collectWindowsServiceDiagnostics({ env, execFileImpl })
    : null;
  const ready = identityState === 'loaded'
    && endpoint.status === 'derived'
    && (!services || services.status === 'ready');
  const tools = await collectWindowsToolDiagnostics({ env, execFileImpl });
  return Object.freeze({
    version: WINDOWS_RUNTIME_DIAGNOSTICS_VERSION,
    platform,
    supported: true,
    status: ready ? 'ready' : 'degraded',
    scope: normalizedScope,
    paths: {
      productRoot: paths.productRoot,
      instanceRoot: paths.instanceRoot,
      configDir: paths.configDir,
      dataDir: paths.dataDir,
      runtimeDir: paths.runtimeDir,
      spoolDir: paths.spoolDir,
      providerHomesDir: paths.providerHomesDir,
      workspaceDir: paths.workspaceDir,
      instanceIdentityFile: paths.instanceIdentityFile,
      ownershipFile: paths.ownershipFile,
    },
    identity: {
      status: identityState,
      ...(identity?.instanceId ? { instanceId: identity.instanceId } : {}),
      ...(identity?.keyFingerprint ? { keyFingerprint: identity.keyFingerprint } : {}),
      ...(identityError ? { error: identityError } : {}),
    },
    endpoint,
    files,
    ...(services ? { services } : {}),
    tools,
  });
}
