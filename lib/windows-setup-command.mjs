import { execFile as execFileCallback, spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runWindowsServiceLifecycle } from './windows-service-control.mjs';
import { resolveWindowsServicePaths } from './windows-runtime-paths.mjs';

export const WINDOWS_SETUP_VERSION = 'windows-setup/v1';
const execFileAsync = promisify(execFileCallback);
const WINDOWS_SERVICES = Object.freeze([
  'AgentoC-RunnerSupervisor',
  'AgentoC-ControlPlane',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function setupError(message, code = 'WINDOWS_SETUP_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function resolveWindowsServiceSetupPaths({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') {
    throw setupError('Windows setup requires native win32.', 'WINDOWS_SETUP_PLATFORM_REQUIRED');
  }
  if (!/^[a-z]:\\/i.test(trimString(env?.ProgramData))) {
    throw setupError('Windows setup requires a local ProgramData path.', 'WINDOWS_SETUP_PROGRAM_DATA_INVALID');
  }
  let paths;
  try {
    paths = resolveWindowsServicePaths({ platform, env });
  } catch (error) {
    throw setupError(
      `Windows service paths are invalid: ${error?.message || String(error)}`,
      'WINDOWS_SETUP_PROGRAM_DATA_INVALID',
    );
  }
  return Object.freeze({
    dataRoot: paths.productRoot,
    instanceRoot: paths.instanceRoot,
    configDir: paths.configDir,
    runtimeDir: paths.runtimeDir,
    authFile: win32.join(paths.configDir, 'auth.json'),
  });
}

export function buildWindowsSetupServiceProbePowerShell() {
  const names = WINDOWS_SERVICES.map(quotePowerShell).join(', ');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$names = @(${names})`,
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

function defaultExecFile(command, args, options) {
  return execFileAsync(command, args, options);
}

function defaultSpawnFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(signal
        ? `${command} exited with signal ${signal}`
        : `${command} exited with code ${code}`);
      error.status = code ?? 1;
      reject(error);
    });
  });
}

function writeOutput(writer, value) {
  if (typeof writer === 'function') writer(value);
  else process.stdout.write(value);
}

function printHelp(writer) {
  writeOutput(writer, `Usage:\n  ragent setup                  Configure an installed Windows MSI\n  ragent setup --check-only    Check Windows MSI service registration\n`);
}

async function probeWindowsServices({ powershellPath, env, execFileImpl }) {
  let result;
  try {
    result = await execFileImpl(powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      buildWindowsSetupServiceProbePowerShell(),
    ], {
      env,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw setupError(
      `Unable to inspect Ragent Windows services: ${error?.message || String(error)}`,
      'WINDOWS_SETUP_SERVICE_PROBE_FAILED',
    );
  }

  let report;
  try {
    report = JSON.parse(String(result?.stdout || '').trim());
  } catch {
    throw setupError('PowerShell returned an invalid Windows service report.', 'WINDOWS_SETUP_SERVICE_PROBE_INVALID');
  }
  if (report?.installed !== true) {
    const missing = Array.isArray(report?.missing) ? report.missing.filter(Boolean).join(', ') : 'required services';
    throw setupError(
      `Ragent Windows services are not installed (${missing}). Install the Ragent Windows package first.`,
      'WINDOWS_SETUP_MSI_REQUIRED',
    );
  }
  return report;
}

async function waitForHealth({ fetchImpl, timeoutMs = 45_000, intervalMs = 500 }) {
  const url = 'http://127.0.0.1:7690/healthz';
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(5_000, Math.max(1, deadline - Date.now())));
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' },
        signal: controller.signal,
      });
      if (response?.ok) return;
      lastError = new Error(`HTTP ${response?.status || 'unknown'}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
  throw setupError(
    `Ragent Control Plane did not become healthy at ${url}: ${lastError?.message || 'timeout'}`,
    'WINDOWS_SETUP_HEALTH_TIMEOUT',
  );
}

export async function runWindowsSetupCommand(args = [], {
  platform = process.platform,
  env = process.env,
  powershellPath = env?.AGENTOC_POWERSHELL || 'powershell.exe',
  nodePath = process.execPath,
  sourceRoot = fileURLToPath(new URL('..', import.meta.url)),
  setPasswordScript,
  execFileImpl = defaultExecFile,
  spawnFileImpl = defaultSpawnFile,
  lifecycleImpl = runWindowsServiceLifecycle,
  fetchImpl = globalThis.fetch,
  writer,
} = {}) {
  if (platform !== 'win32') {
    throw setupError('Windows setup requires native win32.', 'WINDOWS_SETUP_PLATFORM_REQUIRED');
  }
  if (!Array.isArray(args)) throw setupError('Windows setup arguments must be an array.');
  if (args.includes('--help') || args.includes('-h')) {
    printHelp(writer);
    return 0;
  }
  if (typeof fetchImpl !== 'function') throw setupError('Windows setup requires a fetch implementation.');

  const paths = resolveWindowsServiceSetupPaths({ platform, env });
  const powershell = trimString(powershellPath);
  if (!powershell) throw setupError('A PowerShell executable is required.');
  const report = await probeWindowsServices({ powershellPath: powershell, env, execFileImpl });
  if (args.includes('--check-only')) {
    writeOutput(writer, `Ragent Windows services installed: ${WINDOWS_SERVICES.join(', ')}\n`);
    return 0;
  }

  const passwordScript = setPasswordScript || win32.join(sourceRoot, 'set-password.mjs');
  const passwordEnv = {
    ...env,
    AGENTOC_WINDOWS_SERVICE_MODE: '1',
    AGENTOC_INSTANCE_NAME: 'owner',
    AGENTOC_INSTANCE_ROOT: paths.instanceRoot,
    AGENTOC_CONFIG_DIR: paths.configDir,
  };
  await spawnFileImpl(nodePath, [passwordScript], { env: passwordEnv });
  await lifecycleImpl({ action: 'restart', service: 'all', platform, powershellPath: powershell });
  await waitForHealth({ fetchImpl });

  const states = report.states && typeof report.states === 'object' ? report.states : {};
  writeOutput(writer, [
    'Ragent Windows setup complete.',
    `Services: ${WINDOWS_SERVICES.join(', ')}`,
    `Local control plane: http://127.0.0.1:7690/`,
    `Config: ${paths.configDir}`,
    `Previous service states: ${WINDOWS_SERVICES.map((name) => `${name}=${states[name] || 'unknown'}`).join(', ')}`,
  ].join('\n') + '\n');
  return 0;
}
