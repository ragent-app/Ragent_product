import { access, constants as fsConstants } from 'fs/promises';
import { execFile } from 'child_process';
import { delimiter, dirname, join, win32 as win32Path } from 'path';
import { promisify } from 'util';

import { stripDeniedRunnerEnvKeys } from './runner-env.mjs';
import { internalHarnessId, resolveInternalHarnessCommandPath } from './harness-paths.mjs';

const execFileAsync = promisify(execFile);

const SHELL_ENV_EXPORT_B64 = 'RAGENT_USER_SHELL_ENV_B64';
const SHELL_ENV_START_MARKER = '__RAGENT_SHELL_ENV_START__';
const SHELL_ENV_END_MARKER = '__RAGENT_SHELL_ENV_END__';
const SHELL_ENV_PROBE_TIMEOUT_MS = 5000;
const SHELL_ENV_PROBE_MAX_BUFFER = 4 * 1024 * 1024;

const SHELL_ENV_PROBE_MODES = [
  { name: 'interactive-login', args: ['-i', '-l', '-c'] },
  { name: 'interactive', args: ['-i', '-c'] },
  { name: 'login', args: ['-l', '-c'] },
  { name: 'plain', args: ['-c'] },
];

function dedupeEntries(entries = []) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const trimmed = String(entry || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

function collectPathEntries(values = [], { platform = process.platform } = {}) {
  const entries = [];
  const pathValues = Array.isArray(values) ? values : [values];
  const pathSeparator = platform === 'win32' ? ';' : delimiter;
  for (const value of pathValues) {
    if (!value) continue;
    if (Array.isArray(value)) {
      entries.push(...collectPathEntries(value, { platform }));
      continue;
    }
    for (const part of String(value).split(pathSeparator)) {
      const trimmed = part.trim();
      if (trimmed) entries.push(trimmed);
    }
  }
  return dedupeEntries(entries);
}

function formatPath(entries = [], { platform = process.platform } = {}) {
  return dedupeEntries(entries).join(platform === 'win32' ? ';' : delimiter);
}

export function defaultShellForPlatform(platform = process.platform, { env = process.env } = {}) {
  if (platform === 'win32') {
    const root = String(env?.SystemRoot || env?.WINDIR || '').trim();
    return /^[A-Za-z]:[\\/]/.test(root)
      ? win32Path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
  }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export function buildFallbackPathEntries(baseEnv = process.env, { platform = process.platform } = {}) {
  const home = String(baseEnv?.HOME || baseEnv?.USERPROFILE || process.env.HOME || '').trim();
  const nodeBinDir = process.execPath ? dirname(process.execPath) : '';

  if (platform === 'win32') {
    const userProfile = String(baseEnv?.USERPROFILE || home).trim();
    const localAppData = String(baseEnv?.LOCALAPPDATA || '').trim();
    const candidateRoot = String(baseEnv?.SystemRoot || baseEnv?.WINDIR || '').trim();
    const systemRoot = /^[A-Za-z]:[\\/]/.test(candidateRoot) ? candidateRoot.replace(/[\\/]+$/, '') : '';
    const winJoin = (...parts) => win32Path.join(...parts.filter(Boolean));
    return collectPathEntries([
      nodeBinDir,
      userProfile && winJoin(userProfile, 'AppData', 'Roaming', 'npm'),
      userProfile && winJoin(userProfile, '.local', 'bin'),
      userProfile && winJoin(userProfile, '.cargo', 'bin'),
      localAppData && winJoin(localAppData, 'Microsoft', 'WindowsApps'),
      baseEnv?.ProgramFiles && winJoin(baseEnv.ProgramFiles, 'nodejs'),
      systemRoot,
      systemRoot && winJoin(systemRoot, 'System32'),
      systemRoot && winJoin(systemRoot, 'System32', 'Wbem'),
      systemRoot && winJoin(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ], { platform });
  }

  return collectPathEntries([
    nodeBinDir,
    `${home}/.local/bin`,
    process.platform === 'darwin'
      ? [
          `${home}/Library/pnpm`,
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
        ]
      : [
          '/snap/bin',
          `${home}/.nvm/versions/node/current/bin`,
          `${home}/.cargo/bin`,
          `${home}/go/bin`,
        ],
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ], { platform });
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pickShellExecutable({ platform = process.platform, env = process.env, pathExistsImpl = pathExists } = {}) {
  const defaultShell = defaultShellForPlatform(platform, { env });
  const candidates = [
    env?.RAGENT_USER_SHELL,
    env?.SHELL,
    defaultShell,
    '/bin/sh',
  ];
  for (const candidate of candidates) {
    const trimmed = String(candidate || '').trim();
    if (trimmed && await pathExistsImpl(trimmed)) {
      return trimmed;
    }
  }
  return defaultShell;
}

export function buildShellEnvDumpCommand({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    return [
      `[Console]::Write('${SHELL_ENV_START_MARKER}')`,
      "Get-ChildItem Env: | ForEach-Object { [Console]::Write(('{0}={1}' -f $_.Name, $_.Value)); [Console]::Write([char]0) }",
      `[Console]::Write('${SHELL_ENV_END_MARKER}')`,
    ].join('; ');
  }
  return [
    `printf '%s\\0' '${SHELL_ENV_START_MARKER}'`,
    'env -0',
    `printf '%s\\0' '${SHELL_ENV_END_MARKER}'`,
  ].join('; ');
}

function normalizeEnvironmentKeys(source, platform = process.platform) {
  const env = {};
  for (const [rawKey, value] of Object.entries(source || {})) {
    const key = platform === 'win32' && rawKey.toLowerCase() === 'path' ? 'PATH' : rawKey;
    if (key === 'PATH' && Object.prototype.hasOwnProperty.call(env, 'PATH') && rawKey !== 'PATH') continue;
    env[key] = value;
  }
  return env;
}

export function parseEnvDump(stdout, { platform = process.platform } = {}) {
  const output = typeof stdout === 'string' ? stdout : String(stdout || '');
  const startMarker = `${SHELL_ENV_START_MARKER}\u0000`;
  const endMarker = `${SHELL_ENV_END_MARKER}\u0000`;
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return null;
  const payloadStart = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, payloadStart);
  if (endIndex === -1) return null;

  const env = {};
  const payload = output.slice(payloadStart, endIndex);
  for (const record of payload.split('\u0000')) {
    if (!record) continue;
    const separatorIndex = record.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = record.slice(0, separatorIndex);
    const value = record.slice(separatorIndex + 1);
    env[key] = value;
  }
  return normalizeEnvironmentKeys(env, platform);
}

export async function probeShellEnv(shellPath, { platform = process.platform, execFileImpl = execFileAsync } = {}) {
  const isPowerShell = platform === 'win32'
    && /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(String(shellPath || '').trim());
  const modes = isPowerShell
    ? [{ name: 'noninteractive', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }]
    : SHELL_ENV_PROBE_MODES;
  for (const mode of modes) {
    try {
      const { stdout } = await execFileImpl(shellPath, [...mode.args, buildShellEnvDumpCommand({ platform })], {
        encoding: 'utf8',
        timeout: SHELL_ENV_PROBE_TIMEOUT_MS,
        maxBuffer: SHELL_ENV_PROBE_MAX_BUFFER,
      });
      const env = parseEnvDump(stdout, { platform });
      if (env && Object.keys(env).length > 0) {
        return {
          shell: shellPath,
          mode: mode.name,
          env,
        };
      }
    } catch {
    }
  }
  return null;
}

function parseInjectedShellSnapshot(fallbackShell) {
  const encoded = String(process.env[SHELL_ENV_EXPORT_B64] || '').trim();
  if (!encoded) return null;
  try {
    const raw = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.env !== 'object' || !parsed.env) {
      return null;
    }
    return {
      shell: String(parsed.shell || fallbackShell).trim() || fallbackShell,
      mode: String(parsed.mode || 'injected').trim() || 'injected',
      env: { ...parsed.env },
    };
  } catch {
    return null;
  }
}

export function finalizeShellSnapshot(snapshot, fallbackShell, { platform = process.platform } = {}) {
  const shell = String(snapshot?.shell || fallbackShell).trim() || fallbackShell;
  const mode = String(snapshot?.mode || 'fallback').trim() || 'fallback';
  const shellEnv = normalizeEnvironmentKeys(
    snapshot?.env && typeof snapshot.env === 'object' ? snapshot.env : {},
    platform,
  );
  const fullPath = formatPath(
    collectPathEntries([
      shellEnv.PATH,
      process.env.PATH || process.env.Path,
      buildFallbackPathEntries({ ...shellEnv, ...process.env }, { platform }),
    ], { platform }),
    { platform },
  );
  return {
    shell,
    mode,
    env: shellEnv,
    fullPath,
  };
}

const preferredShell = await pickShellExecutable();
const resolvedShellSnapshot = finalizeShellSnapshot(
  parseInjectedShellSnapshot(preferredShell)
  || await probeShellEnv(preferredShell)
  || { shell: preferredShell, mode: 'fallback', env: {} },
  preferredShell,
);

export const userShell = resolvedShellSnapshot.shell;
export const userShellMode = resolvedShellSnapshot.mode;
export const userShellEnv = Object.freeze({ ...resolvedShellSnapshot.env, PATH: resolvedShellSnapshot.fullPath });
export const fullPath = userShellEnv.PATH;

export function serializeUserShellEnvSnapshot() {
  const existing = String(process.env[SHELL_ENV_EXPORT_B64] || '').trim();
  if (existing) {
    // Re-encode an injected snapshot through the runner deny-list so a snapshot
    // produced by an older control plane can never smuggle production config
    // paths into a Run's interactive shell env.
    const injected = parseInjectedShellSnapshot(userShell);
    if (injected) {
      return Buffer.from(
        JSON.stringify({
          shell: injected.shell,
          mode: injected.mode,
          env: stripDeniedRunnerEnvKeys(injected.env),
        }),
        'utf8',
      ).toString('base64');
    }
    return existing;
  }
  return Buffer.from(
    JSON.stringify({
      shell: userShell,
      mode: userShellMode,
      env: stripDeniedRunnerEnvKeys(userShellEnv),
    }),
    'utf8',
  ).toString('base64');
}

export function buildToolProcessEnv(overrides = {}) {
  const sandboxMode = String(process.env.IS_SANDBOX || '').trim();
  const env = {
    ...userShellEnv,
    ...process.env,
    ...(sandboxMode ? {} : { IS_SANDBOX: '1' }),
    ...overrides,
  };
  if (process.platform === 'win32' && Object.prototype.hasOwnProperty.call(env, 'Path')) {
    delete env.Path;
  }
  env.PATH = formatPath(
    collectPathEntries([
      overrides.PATH,
      userShellEnv.PATH,
      process.env.PATH || process.env.Path,
      buildFallbackPathEntries(env, { platform: process.platform }),
    ], { platform: process.platform }),
    { platform: process.platform },
  );
  return env;
}

async function isExecutableFile(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutableCommandPathAsync(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;
  if (internalHarnessId(trimmed)) return resolveInternalHarnessCommandPath(trimmed);
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return await isExecutableFile(trimmed) ? trimmed : null;
  }
  for (const dir of collectPathEntries(fullPath, { platform: process.platform })) {
    const candidate = join(dir, trimmed);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}
