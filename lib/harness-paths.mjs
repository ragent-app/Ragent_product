import { access, constants, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { PACKAGED_HARNESS_ROOT, packagedHarnessCommandPath } from './packaged-harness-runtime.mjs';

export const HARNESS_ROOT = process.env.RAGENT_HARNESS_ROOT
  || (process.platform === 'win32'
    ? join(process.env.ProgramData || 'C:\\ProgramData', 'Ragent', 'harnesses')
    : join(homedir(), '.local', 'share', 'ragent', 'harnesses'));
export function usesWindowsServiceHarnessState(env = process.env, platform = process.platform) {
  return platform === 'win32' && (env.RAGENT_WINDOWS_SERVICE_MODE === '1'
    || env.RAGENT_RUNNER_LAUNCH_MODE === 'runner-supervisor');
}
export function harnessInstallationStatePath(configDir, { env = process.env, platform = process.platform, harnessRoot = HARNESS_ROOT } = {}) {
  return join(usesWindowsServiceHarnessState(env, platform) ? harnessRoot : configDir, 'harness-installations.json');
}
const COMMANDS = Object.freeze({
  codex: 'codex', claude: 'claude', agy: 'agy', pi: 'pi', 'deepseek-harness': 'dsh',
  'qwen-code': 'qwen', opencode: 'opencode', 'kimi-code': 'kimi', goose: 'goose',
  openhands: 'agent-canvas', copilot: 'copilot', hermes: 'hermes-acp', cline: 'cline', kilo: 'kilo',
});
const SCRIPT_IDS = new Set(['agy', 'goose', 'hermes']);
const ALIASES = { 'codex-cli': 'codex', 'ragent-codex-app-server': 'codex', 'claude-bidi': 'claude', 'kilo-code': 'kilo' };

export function internalHarnessId(command) {
  const name = basename(String(command || '').trim().replaceAll('\\', '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return ALIASES[name] || (COMMANDS[name] ? name : Object.keys(COMMANDS).find((id) => COMMANDS[id] === name)) || null;
}

export function internalHarnessCommandCandidates(id) {
  const command = COMMANDS[id];
  if (!command) return [];
  const root = join(HARNESS_ROOT, id);
  const win = process.platform === 'win32';
  const candidates = SCRIPT_IDS.has(id)
    ? [join(root, 'bin', `${command}${win ? '.exe' : ''}`), join(root, 'bin', `${command}${win ? '.cmd' : ''}`)]
    : [join(root, 'node_modules', '.bin', `${command}${win ? '.cmd' : ''}`)];
  if (id === 'hermes') candidates.push(
    join(root, 'home', 'bin', `${command}${win ? '.cmd' : ''}`),
    join(root, 'app', '.venv', win ? 'Scripts' : 'bin', `${command}${win ? '.exe' : ''}`),
    join(root, 'app', 'venv', win ? 'Scripts' : 'bin', `${command}${win ? '.exe' : ''}`),
  );
  if (PACKAGED_HARNESS_ROOT) candidates.push(packagedHarnessCommandPath(command));
  return [...new Set(candidates)];
}

function within(root, value) {
  const part = relative(resolve(root), value);
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export async function resolveInternalHarnessCommandPath(command, { respectInstallationState = true } = {}) {
  const id = internalHarnessId(command);
  if (!id) return null;
  if (respectInstallationState) {
    // Deferred to avoid a config -> resolver initialization cycle. Registry and
    // one-shot CLI consumers must honor the same explicit uninstall decision.
    const { CONFIG_DIR } = await import('./config.mjs');
    try {
      const state = JSON.parse(await readFile(harnessInstallationStatePath(CONFIG_DIR), 'utf8'));
      if (state[id]?.installed === false) return null;
    } catch (error) { if (error.code !== 'ENOENT' || usesWindowsServiceHarnessState()) return null; }
  }
  for (const candidate of internalHarnessCommandCandidates(id)) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      const actual = await realpath(candidate);
      if (!within(HARNESS_ROOT, actual) && !(PACKAGED_HARNESS_ROOT && within(PACKAGED_HARNESS_ROOT, actual))) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export function buildInternalHarnessInstallerEnvironment(id, version, baseEnv = process.env) {
  if (!COMMANDS[id]) throw new Error('Unknown internal Harness');
  const root = join(HARNESS_ROOT, id);
  const home = join(root, 'home');
  return {
    ...baseEnv, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'),
    GOOSE_BIN_DIR: join(root, 'bin'), GOOSE_VERSION: version,
    HERMES_HOME: home, UV_TOOL_DIR: join(root, 'uv-tools'), UV_TOOL_BIN_DIR: join(root, 'bin'),
    CONFIGURE: 'false',
  };
}
