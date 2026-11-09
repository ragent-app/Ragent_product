// Claude Code MCP server management. The Connector panel surfaces the user's
// Claude Code MCP servers (user scope of ~/.claude.json) and manages them
// through the `claude mcp` CLI itself — the CLI is the authoritative writer,
// so AgentoC never rewrites Claude config directly. Listing reads the config
// file directly instead of `claude mcp list` because the CLI health-checks
// every server (seconds per server); env values are stripped so credentials
// stored in the config never leave the machine. All subprocess calls are
// short-lived, time-boxed, and (for tests) redirectable via
// AGENTOC_CLAUDE_CONFIG_DIR.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import {
  buildPlatformSpawnSpec,
  resolveExecutableCommandPathAsync,
} from './executable-resolution.mjs';

const execFileAsync = promisify(execFile);

const CLAUDE_MCP_TIMEOUT_MS = 15000;
const CLAUDE_MCP_MAX_BUFFER = 1024 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// `claude` resolves its config file as $CLAUDE_CONFIG_DIR/.claude.json,
// defaulting to $HOME/.claude.json. AGENTOC_CLAUDE_CONFIG_DIR redirects it
// (tests use a temp dir so the real ~/.claude.json is never touched).
function claudeConfigDir() {
  return trimString(process.env.AGENTOC_CLAUDE_CONFIG_DIR)
    || process.env.CLAUDE_CONFIG_DIR
    || homedir();
}

function claudeConfigFile(options = {}) {
  const configuredDir = trimString(options.configDir)
    || trimString(process.env.AGENTOC_CLAUDE_CONFIG_DIR)
    || trimString(process.env.CLAUDE_CONFIG_DIR)
    || homedir();
  return join(configuredDir, '.claude.json');
}

function claudeBin() {
  return 'claude';
}

async function resolveClaudeMcpSpawnSpec(args, env) {
  const command = claudeBin();
  const resolved = await resolveExecutableCommandPathAsync(command, { env });
  if (!resolved) {
    const error = new Error(`Claude executable not found: ${command}`);
    error.code = 'CLAUDE_MCP_COMMAND_NOT_FOUND';
    throw error;
  }
  return buildPlatformSpawnSpec(resolved, args, { env });
}

async function runClaudeMcp(args, { configDir, timeoutMs = CLAUDE_MCP_TIMEOUT_MS } = {}) {
  const env = { ...process.env };
  const override = trimString(configDir) || trimString(process.env.AGENTOC_CLAUDE_CONFIG_DIR);
  if (override) {
    env.CLAUDE_CONFIG_DIR = override;
  }
  try {
    const spawnSpec = await resolveClaudeMcpSpawnSpec(args, env);
    const { stdout } = await execFileAsync(spawnSpec.file, spawnSpec.args, {
      timeout: timeoutMs,
      maxBuffer: CLAUDE_MCP_MAX_BUFFER,
      env: spawnSpec.env,
      shell: spawnSpec.shell,
      windowsHide: true,
      ...(spawnSpec.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
    });
    return { ok: true, stdout };
  } catch (error) {
    // claude explains failures on stderr; prefer that over the generic error.
    return {
      ok: false,
      error: trimString(error?.stderr || error?.message || 'claude mcp failed'),
    };
  }
}

export async function listClaudeMcpServers(options = {}) {
  let raw = '';
  try {
    raw = await readFile(claudeConfigFile(options), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, servers: [] };
    }
    return { ok: false, error: trimString(error?.message || 'failed to read claude config'), servers: [] };
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'claude config is not valid json', servers: [] };
  }
  const mcpServers = config && typeof config === 'object' && !Array.isArray(config)
    ? config.mcpServers
    : null;
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    return { ok: true, servers: [] };
  }
  const servers = Object.entries(mcpServers)
    .filter(([, entry]) => entry && typeof entry === 'object')
    .map(([name, entry]) => {
      const type = trimString(entry.type);
      const server = {
        name,
        scope: 'user',
        ...(type ? { type } : {}),
      };
      if (type === 'http' || type === 'sse') {
        if (typeof entry.url === 'string' && entry.url) server.url = entry.url;
      } else {
        if (typeof entry.command === 'string' && entry.command) server.command = entry.command;
        if (Array.isArray(entry.args)) server.args = entry.args.map(String);
      }
      // Env var names only — values are credentials and must never leave the server.
      const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env : {};
      const envKeys = Object.keys(env);
      if (envKeys.length > 0) server.envKeys = envKeys;
      return server;
    });
  return { ok: true, servers };
}

export async function addClaudeMcpServer(
  { name, command = '', args = [], url = '', env = {} },
  options = {},
) {
  const serverName = trimString(name);
  if (!serverName) {
    return { ok: false, error: 'name is required' };
  }
  // We manage the user scope only, like the codex panel manages ~/.codex.
  const cliArgs = ['mcp', 'add', '-s', 'user', serverName];
  const serverUrl = trimString(url);
  if (serverUrl) {
    // Without --transport, claude would treat the URL as a stdio command.
    cliArgs.push('--transport', 'http', serverUrl);
  } else {
    const commandLine = trimString(command);
    if (!commandLine) {
      return { ok: false, error: 'command or url is required' };
    }
    // -e entries only apply to stdio servers and go before the `--` separator.
    for (const [key, value] of Object.entries(env || {})) {
      const envKey = trimString(key);
      const envValue = trimString(String(value));
      if (envKey && envValue) {
        cliArgs.push('-e', `${envKey}=${envValue}`);
      }
    }
    cliArgs.push('--', ...commandLine.split(/\s+/).filter(Boolean), ...args.map(String).filter(Boolean));
  }
  const result = await runClaudeMcp(cliArgs, options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

export async function removeClaudeMcpServer({ name }, options = {}) {
  const serverName = trimString(name);
  if (!serverName) {
    return { ok: false, error: 'name is required' };
  }
  // Pin the scope so a same-named project-local (.mcp.json) server is never
  // removed by accident.
  const result = await runClaudeMcp(['mcp', 'remove', '-s', 'user', serverName], options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}
