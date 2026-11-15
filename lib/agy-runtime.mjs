// AgY runtime boundary.
//
// AgY keeps both its files and its Secret Service credential in the user's
// process environment.  HOME alone is not an account boundary on Linux: the
// session D-Bus/keyring is shared by every HOME under the desktop login.  The
// launcher below gives AgY a managed HOME and, on Linux, a private D-Bus
// session so an old external AgY process cannot overwrite the selected one.

import { access, chmod, constants as fsConstants, copyFile, mkdir, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { AGY_CONTROL_HOME_DIR } from './config.mjs';
import { resolveExecutableCommandPathAsync } from './executable-resolution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const AGY_RUNTIME_LAUNCHER_PATH = join(__dirname, '..', 'scripts', 'agy-runtime-launcher.mjs');
export const AGY_RUNTIME_HOME_ENV = 'RAGENT_AGY_HOME_DIR';
export const AGY_AUTH_RELATIVE_PATH = join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathFromEnv(value) {
  const candidate = trimString(value);
  if (!candidate) return '';
  return isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
}

export function isAgyRuntime({ toolId = '', runtimeFamily = '' } = {}) {
  const tool = trimString(toolId).toLowerCase();
  const family = trimString(runtimeFamily).toLowerCase();
  return tool === 'agy' || family === 'agy-json' || family === 'agy-stream-json';
}

// AgY stream-json consumes one user event per NDJSON line. Keeping this
// serializer in the runtime boundary makes the sidecar and direct API path
// use the same protocol, including for prompts containing newlines or quotes.
export function buildAgyStreamInput(prompt) {
  const content = prompt === undefined || prompt === null ? '' : String(prompt);
  return `${JSON.stringify({
    event: 'user',
    message: { role: 'user', content },
  })}\n`;
}

export function resolveAgyHome({ homeDir = '', environment = process.env, control = false } = {}) {
  const explicit = pathFromEnv(homeDir) || pathFromEnv(environment?.[AGY_RUNTIME_HOME_ENV]);
  if (explicit) return explicit;
  if (control) return AGY_CONTROL_HOME_DIR;
  const runnerHome = pathFromEnv(environment?.RAGENT_PROVIDER_HOMES_DIR);
  if (runnerHome && trimString(environment?.RAGENT_RUNNER_LAUNCH_MODE)) {
    return join(runnerHome, 'agy');
  }
  return AGY_CONTROL_HOME_DIR;
}

export async function ensureAgyHome(homeDir = AGY_CONTROL_HOME_DIR) {
  const resolvedHome = pathFromEnv(homeDir) || AGY_CONTROL_HOME_DIR;
  await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
  await chmod(resolvedHome, 0o700).catch(() => {});
  return resolvedHome;
}

export function resolveAgyAuthFile(homeDir = AGY_CONTROL_HOME_DIR) {
  return join(pathFromEnv(homeDir) || AGY_CONTROL_HOME_DIR, AGY_AUTH_RELATIVE_PATH);
}

// The control plane owns the official login, while each Run gets a fresh copy
// of the CLI token in its own HOME.  This keeps the runner away from control
// files and prevents concurrent AgY Runs from sharing mutable CLI state.
export async function prepareAgyRunHome({
  homeDir,
  sourceHome = AGY_CONTROL_HOME_DIR,
  runnerReadable = false,
  runnerOwnerUid = null,
  runnerOwnerGid = null,
  copyFileImpl = copyFile,
  chmodImpl = chmod,
  mkdirImpl = mkdir,
  statImpl = stat,
  chownImpl = null,
} = {}) {
  const targetHome = await ensureAgyHome(homeDir);
  const targetAuthFile = resolveAgyAuthFile(targetHome);
  const sourceAuthFile = resolveAgyAuthFile(sourceHome);
  let sourceInfo;
  try {
    sourceInfo = await statImpl(sourceAuthFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'agy-credential-missing', homeDir: targetHome, authFile: targetAuthFile };
    }
    throw error;
  }
  if (!sourceInfo.isFile() || sourceInfo.size <= 0) {
    return { ok: false, reason: 'agy-credential-missing', homeDir: targetHome, authFile: targetAuthFile };
  }

  const authDir = dirname(targetAuthFile);
  const geminiDir = dirname(authDir);
  await mkdirImpl(authDir, { recursive: true, mode: runnerReadable ? 0o770 : 0o700 });
  await chmodImpl(targetHome, runnerReadable ? 0o770 : 0o700).catch(() => {});
  await chmodImpl(geminiDir, runnerReadable ? 0o770 : 0o700).catch(() => {});
  await chmodImpl(authDir, runnerReadable ? 0o770 : 0o700).catch(() => {});
  await copyFileImpl(sourceAuthFile, targetAuthFile);
  await chmodImpl(targetAuthFile, runnerReadable ? 0o640 : 0o600).catch(() => {});

  if (Number.isInteger(runnerOwnerUid) && Number.isInteger(runnerOwnerGid) && typeof chownImpl === 'function') {
    for (const path of [targetHome, geminiDir, authDir, targetAuthFile]) {
      await chownImpl(path, runnerOwnerUid, runnerOwnerGid);
    }
  }
  return { ok: true, homeDir: targetHome, authFile: targetAuthFile };
}

export async function buildAgyRuntimeEnv(baseEnv = {}, options = {}) {
  const env = { ...baseEnv };
  const homeDir = await ensureAgyHome(resolveAgyHome(options));
  const platform = options.platform || process.platform;

  env.HOME = homeDir;
  env[AGY_RUNTIME_HOME_ENV] = homeDir;
  // `AGY_HOME` is an external CLI override commonly used by terminal
  // profiles.  Leaving it in the child environment defeats the managed HOME
  // boundary and lets a terminal login overwrite another AgY account.
  delete env.AGY_HOME;
  env.XDG_CONFIG_HOME = join(homeDir, '.config');
  env.XDG_CACHE_HOME = join(homeDir, '.cache');
  env.XDG_DATA_HOME = join(homeDir, '.local', 'share');

  if (platform === 'win32') {
    // Node's os.homedir() and many Windows CLIs ignore HOME and resolve from
    // USERPROFILE/APPDATA instead. Bind all common roots to the same managed
    // directory so the boundary behaves the same on Windows deployments.
    env.USERPROFILE = homeDir;
    env.APPDATA = join(homeDir, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(homeDir, 'AppData', 'Local');
  }

  // These point at the desktop user's keyring.  The launcher replaces them
  // with a private session when possible and uses an unreachable address in
  // the dependency-free fallback; either way they must never leak through.
  delete env.GNOME_KEYRING_CONTROL;
  delete env.GNOME_KEYRING_PID;
  if (platform === 'linux') {
    env.RAGENT_AGY_PRIVATE_KEYRING = '1';
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/ragent-agy-private-bus';
  }
  return env;
}

export function buildAgyRuntimeLaunchSpec({
  command,
  args = [],
  env = process.env,
  cwd,
  nodePath = process.execPath,
  launcherPath = AGY_RUNTIME_LAUNCHER_PATH,
} = {}) {
  const target = trimString(command);
  if (!target) throw new Error('AgY runtime command is required');
  const launcher = pathFromEnv(launcherPath);
  if (!launcher) throw new Error('AgY runtime launcher path is invalid');
  const spec = {
    file: nodePath,
    args: [launcher, '--', target, ...args.map((value) => String(value))],
    shell: false,
    env,
  };
  if (cwd !== undefined) spec.cwd = cwd;
  return spec;
}

export function shellQuote(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function buildAgyRuntimeShellCommand({
  command,
  args = [],
  nodePath = process.execPath,
  launcherPath = AGY_RUNTIME_LAUNCHER_PATH,
} = {}) {
  return [nodePath, launcherPath, '--', command, ...args]
    .map(shellQuote)
    .join(' ');
}

export async function resolveAgySupportCommand(command) {
  const value = trimString(command);
  if (!value) return null;
  try {
    return await resolveExecutableCommandPathAsync(value);
  } catch {
    return null;
  }
}

export async function canReadExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runtimeTempRoot() {
  return trimString(process.env.TMPDIR) || tmpdir();
}

export function pathEntries(value = process.env.PATH) {
  return String(value || '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export { AGY_CONTROL_HOME_DIR };
