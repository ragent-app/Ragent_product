import { chmod, copyFile, lstat, mkdir, readFile, readlink, symlink, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  CLAUDE_MANAGED_HOME_DIR,
  CODEX_CONTROL_HOME_DIR,
  CODEX_MANAGED_HOME_DIR,
} from '../lib/config.mjs';
import { buildAgyRuntimeEnv, isAgyRuntime } from '../lib/agy-runtime.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  pathExists,
  writeTextAtomic,
} from './fs-utils.mjs';
import { readPromptAsset } from './prompt-asset-loader.mjs';

async function readInlinePromptAsset(relativePath) {
  return (await readPromptAsset(relativePath)).replace(/\s+/g, ' ').trim();
}

export const MANAGER_RUNTIME_BOUNDARY_SECTION = (await readPromptAsset('runtime/manager-boundary.md')).trim();
export const DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS = await readInlinePromptAsset('runtime/codex-developer-instructions.txt');

const DEFAULT_CODEX_HOME_MODE = 'managed';
const MANAGED_CODEX_CONFIG_MARKER = '# AgentoC-managed Codex runtime home.';
const MANAGED_CODEX_HOME_NOTES = [
  MANAGED_CODEX_CONFIG_MARKER,
  '# Keep this intentionally minimal.',
  '# AgentoC injects workflow, memory policy, and reply-style steering per run.',
  '# Plugins stay off here because AgentoC does not rely on the Codex plugin',
  '# marketplace, and startup syncs can trigger extra ChatGPT-side auth/challenge',
  '# traffic in proxied environments.',
  '',
  '# This instance cannot complete the Codex Responses WebSocket handshake',
  '# quickly enough; using the built-in OpenAI provider makes each turn wait',
  '# for repeated reconnect attempts before falling back to HTTPS. Define an',
  '# equivalent ChatGPT-auth provider that advertises HTTPS-only streaming so',
  '# Codex starts on the working transport immediately.',
  'model_provider = "openai-http"',
  '',
  '[model_providers.openai-http]',
  'name = "OpenAI HTTPS"',
  'base_url = "https://chatgpt.com/backend-api/codex"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  '',
  '[features]',
  'plugins = false',
  '# The unified exec path can leave Codex waiting on an internal exec-server',
  '# child during the next turn, producing repeated reconnect retries before',
  '# any model output appears. AgentoC already owns process isolation and',
  '# command execution at the outer runtime layer, so keep this path disabled.',
  'unified_exec = false',
  '',
].join('\n');

const PERSONAL_CODEX_HOME = join(homedir(), '.codex');
const PERSONAL_CODEX_AUTH_FILE = join(PERSONAL_CODEX_HOME, 'auth.json');
const managedCodexHomeQueue = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCodexHomeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'personal' || normalized === 'inherit') {
    return 'personal';
  }
  return DEFAULT_CODEX_HOME_MODE;
}

function externalCodexOAuthOwnershipEnabled() {
  // Native Codex OAuth is machine-local. Keep the legacy helper shape so old
  // callers remain harmless, but never let an environment flag redirect a
  // control-side process to the user's ~/.codex auth chain.
  return false;
}

function resolveExternalCodexHomeDir() {
  const configured = trimString(process.env.AGENTOC_EXTERNAL_CODEX_HOME);
  return configured || PERSONAL_CODEX_HOME;
}

async function ensureSymlinkOrCopy(sourcePath, targetPath) {
  if (!await pathExists(sourcePath)) {
    return false;
  }

  try {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = await readlink(targetPath);
      if (currentTarget === sourcePath) {
        return true;
      }
    }
    await unlink(targetPath);
  } catch {
  }

  try {
    await symlink(sourcePath, targetPath);
    return true;
  } catch {
  }

  try {
    await copyFile(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

async function shouldWriteManagedCodexConfig(configPath) {
  try {
    return !(await readFile(configPath, 'utf8')).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    // An unreadable non-empty configuration must never be replaced with a
    // default. Let the caller surface the original filesystem error instead.
    throw error;
  }
}

async function readManagedClaudeSettingsEnv(claudeConfigDir = CLAUDE_MANAGED_HOME_DIR) {
  try {
    const text = await readFile(join(claudeConfigDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(text);
    return parsed?.env && typeof parsed.env === 'object' ? parsed.env : {};
  } catch {
    return {};
  }
}


function cleanEnvString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function applyClaudeManagedProviderEnv(env) {
  if (!env || typeof env !== 'object') return env;
  const hasManagedAnthropicProvider = Boolean(
    cleanEnvString(env.ANTHROPIC_BASE_URL)
      || cleanEnvString(env.ANTHROPIC_MODEL)
      || cleanEnvString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      || cleanEnvString(env.ANTHROPIC_DEFAULT_SONNET_MODEL)
      || cleanEnvString(env.ANTHROPIC_DEFAULT_OPUS_MODEL)
  );
  if (!hasManagedAnthropicProvider) return env;

  // Claude Code treats opus/sonnet/haiku/default as aliases and can remap
  // them through legacy provider defaults unless the host marks the provider
  // as managed. Native provider profiles declare the concrete
  // Anthropic-compatible model IDs in env; make those declarations authoritative
  // for every spawned runtime.
  if (!cleanEnvString(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  }
  if (!cleanEnvString(env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)) {
    env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP = '1';
  }
  const haikuModel = cleanEnvString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    || cleanEnvString(env.ANTHROPIC_MODEL);
  if (!cleanEnvString(env.ANTHROPIC_SMALL_FAST_MODEL) && haikuModel) {
    env.ANTHROPIC_SMALL_FAST_MODEL = haikuModel;
  }
  const sonnetModel = cleanEnvString(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  const opusModel = cleanEnvString(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  if (!cleanEnvString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME) && haikuModel) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = haikuModel;
  }
  if (!cleanEnvString(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME) && sonnetModel) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = sonnetModel;
  }
  if (!cleanEnvString(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME) && opusModel) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = opusModel;
  }
  return env;
}

async function ensureManagedClaudeHome(options = {}) {
  const homeDir = typeof options.homeDir === 'string' && options.homeDir.trim()
    ? options.homeDir.trim()
    : CLAUDE_MANAGED_HOME_DIR;
  const claudeConfigDir = typeof options.claudeConfigDir === 'string' && options.claudeConfigDir.trim()
    ? options.claudeConfigDir.trim()
    : CLAUDE_MANAGED_HOME_DIR;

  await ensureDir(homeDir);
  await ensureDir(claudeConfigDir);

  const claudeLinkPath = join(homeDir, '.claude');
  try {
    const existing = await lstat(claudeLinkPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = await readlink(claudeLinkPath);
      if (currentTarget === claudeConfigDir) return homeDir;
      await unlink(claudeLinkPath);
    } else {
      return homeDir;
    }
  } catch {
  }

  try {
    await symlink(claudeConfigDir, claudeLinkPath);
  } catch {
  }
  return homeDir;
}

export async function ensureManagedCodexHome(options = {}) {
  return managedCodexHomeQueue(async () => {
    const homeDir = typeof options.homeDir === 'string' && options.homeDir.trim()
      ? options.homeDir.trim()
      : CODEX_MANAGED_HOME_DIR;
    const authSource = typeof options.authSource === 'string' && options.authSource.trim()
      ? options.authSource.trim()
      : PERSONAL_CODEX_AUTH_FILE;

    await ensureDir(homeDir);
    await chmod(homeDir, 0o2770).catch(() => {});
    const configPath = join(homeDir, 'config.toml');
    if (await shouldWriteManagedCodexConfig(configPath)) {
      await writeTextAtomic(configPath, MANAGED_CODEX_HOME_NOTES, { mode: 0o640 });
      await chmod(configPath, 0o640).catch(() => {});
    }
    await writeTextAtomic(join(homeDir, 'AGENTS.md'), '', { mode: 0o640 });
    await chmod(join(homeDir, 'AGENTS.md'), 0o640).catch(() => {});
    const authPath = join(homeDir, 'auth.json');
    const authStat = await lstat(authPath).catch(() => null);
    if (authStat?.isSymbolicLink()) {
      await unlink(authPath).catch(() => {});
    }
    if (!authStat || authStat.isSymbolicLink() || !await pathExists(authPath)) {
      // `homeDir` was created above. Repeating mkdir with a setgid mode can
      // fail for an already-existing runner-owned directory on filesystems
      // where the process may not change its group, even though the directory
      // itself is writable. Keep this path an existence check and let the
      // initial chmod above establish the intended mode when permitted.
      await ensureDir(homeDir);
      await copyFile(authSource, authPath).catch(() => {});
    }
    await chmod(authPath, 0o640).catch(() => {});
    return homeDir;
  });
}

export async function applyManagedRuntimeEnv(toolId, baseEnv = {}, options = {}) {
  // Control-side (chat-server) one-shot calls never pass codexHomeDir: they
  // are not an isolated Run, so they must not land on the runner-owned shared
  // home.  Route them to the control-owned sibling home unless the caller
  // explicitly picked a directory (the sidecar always does).
  const externalCodexHome = externalCodexOAuthOwnershipEnabled()
    ? resolveExternalCodexHomeDir()
    : '';
  const controlSideCodexHome = trimString(options.codexHomeDir) === ''
    && (trimString(options.codexHomeMode) === '' || trimString(options.codexHomeMode) === 'managed')
    ? (externalCodexHome || CODEX_CONTROL_HOME_DIR)
    : '';
  const env = { ...baseEnv };
  const runtimeFamily = typeof options.runtimeFamily === 'string'
    ? options.runtimeFamily.trim()
    : '';
  const isCodexRuntime = toolId === 'codex'
    || toolId === 'codex-cli'
    || runtimeFamily === 'codex-json'
    || runtimeFamily === 'codex-app-server-json';
  const isClaudeRuntime = toolId === 'claude'
    || toolId === 'claude-bidi'
    || runtimeFamily === 'claude-stream-json'
    || runtimeFamily === 'claude-stream-json-bidi';
  const isAgy = isAgyRuntime({ toolId, runtimeFamily });
  if (isAgy) {
    const agyHomeDir = trimString(options.agyHomeDir);
    if (!agyHomeDir) {
      throw new Error('AgY runtime requires a prepared account-scoped HOME');
    }
    return buildAgyRuntimeEnv(env, {
      homeDir: agyHomeDir,
      environment: env,
    });
  }
  if (isClaudeRuntime) {
    const claudeConfigDir = typeof options.claudeHomeDir === 'string' && options.claudeHomeDir.trim()
      ? options.claudeHomeDir.trim()
      : CLAUDE_MANAGED_HOME_DIR;
    const managedClaudeHome = await ensureManagedClaudeHome({
      homeDir: options.claudeHomeBridgeDir,
      claudeConfigDir,
    });
    const managedClaudeEnv = applyClaudeManagedProviderEnv({
      ...await readManagedClaudeSettingsEnv(claudeConfigDir),
    });
    for (const [key, value] of Object.entries(managedClaudeEnv)) {
      if (value === undefined || value === null) continue;
      env[key] = typeof value === 'string' ? value : String(value);
    }
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    env.HOME = managedClaudeHome;
  }
  const genericHarnessFamilies = new Map([
    ['pi-rpc-jsonl', 'pi'], ['qwen-code-acp', 'qwen-code'],
    ['opencode-json', 'opencode'], ['kimi-code-acp', 'kimi-code'],
    ['goose-headless', 'goose'], ['openhands-headless', 'openhands'],
    ['copilot-json', 'copilot'], ['hermes-acp', 'hermes'],
    ['cline-json', 'cline'], ['kilo-json', 'kilo'],
  ]);
  const harnessId = genericHarnessFamilies.get(runtimeFamily);
  const harnessHomeDir = trimString(options.harnessHomeDir);
  if (harnessId && harnessHomeDir) {
    // Generic harnesses keep their own config/session state inside the
    // broker-prepared per-Run home. This is also where Qwen's ~/.qwen and
    // Kimi's ~/.kimi-code config files are materialized.
    env.HOME = harnessHomeDir;
    if (process.platform === 'win32') env.USERPROFILE = harnessHomeDir;
    if (harnessId === 'copilot') env.COPILOT_HOME = harnessHomeDir;
    if (harnessId === 'hermes') env.HERMES_HOME = harnessHomeDir;
    if (harnessId === 'kimi-code') env.KIMI_CODE_HOME = join(harnessHomeDir, '.kimi-code');
    if (harnessId === 'cline') {
      env.CLINE_DATA_DIR = harnessHomeDir;
      env.CLINE_PROVIDER_SETTINGS_PATH = join(harnessHomeDir, 'settings', 'providers.json');
    }
    if (harnessId === 'kilo') env.KILO_CONFIG = join(harnessHomeDir, 'kilo.jsonc');
    const dotenv = await readFile(join(harnessHomeDir, '.agentoc-provider.env'), 'utf8').catch(() => '');
    for (const line of dotenv.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match) continue;
      try { env[match[1]] = JSON.parse(match[2]); } catch { /* malformed generated line */ }
    }
    if (harnessId === 'opencode') env.OPENCODE_CONFIG = join(harnessHomeDir, 'opencode.json');
    if (harnessId === 'openhands') {
      const openhandsEnv = await readFile(join(harnessHomeDir, '.agentoc-openhands.env'), 'utf8').catch(() => '');
      for (const line of openhandsEnv.split(/\r?\n/)) {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (!match) continue;
        try { env[match[1]] = JSON.parse(match[2]); } catch { /* generated file only */ }
      }
    }
  }
  if (!isCodexRuntime) {
    return env;
  }

  const mode = normalizeCodexHomeMode(options.codexHomeMode || process.env.AGENTOC_CODEX_HOME_MODE);
  if (mode === 'personal') {
    return env;
  }

  const managedHome = await ensureManagedCodexHome({
    homeDir: controlSideCodexHome || options.codexHomeDir,
    authSource: options.codexAuthSource,
  });
  delete env.CODEX_HOME;
  env.CODEX_HOME = managedHome;
  return env;
}
