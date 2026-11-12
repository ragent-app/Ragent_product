// Codex CLI MCP server management. The Connector panel surfaces the user's
// codex mcp_servers (~/.codex/config.toml) and manages them through the
// `codex mcp` CLI itself — the CLI is the authoritative source, so AgentoC
// never parses TOML or rewrites codex config directly. All subprocess calls
// are short-lived, time-boxed, and (for tests) redirectable via HOME.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  buildPlatformSpawnSpec,
  resolveExecutableCommandPathAsync,
} from './executable-resolution.mjs';

const execFileAsync = promisify(execFile);

const CODEX_MCP_TIMEOUT_MS = 15000;
const CODEX_MCP_MAX_BUFFER = 1024 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// AGENTOC_CODEX_HOME redirects the codex config root (tests use a temp HOME
// so the real ~/.codex is never touched); default is the service user home.
function codexHome() {
  return trimString(process.env.AGENTOC_CODEX_HOME) || homedir();
}

function codexBin() {
  return 'codex';
}

async function resolveCodexMcpSpawnSpec(args, env) {
  const command = codexBin();
  const resolved = await resolveExecutableCommandPathAsync(command, { env });
  if (!resolved) {
    const error = new Error(`Codex executable not found: ${command}`);
    error.code = 'CODEX_MCP_COMMAND_NOT_FOUND';
    throw error;
  }
  return buildPlatformSpawnSpec(resolved, args, { env });
}

async function runCodexMcp(args, { home, codexHomeDir, timeoutMs = CODEX_MCP_TIMEOUT_MS } = {}) {
  try {
    // The provider runner may set CODEX_HOME to its private runtime state.
    // This owner-facing management command is intentionally scoped by HOME;
    // inheriting that variable would bypass the test/instance redirect and
    // expose or mutate a provider-specific MCP catalog.
    const env = { ...process.env };
    if (codexHomeDir) env.CODEX_HOME = codexHomeDir;
    else {
      delete env.CODEX_HOME;
      env.HOME = home || codexHome();
    }
    const spawnSpec = await resolveCodexMcpSpawnSpec(args, env);
    const { stdout } = await execFileAsync(spawnSpec.file, spawnSpec.args, {
      timeout: timeoutMs,
      maxBuffer: CODEX_MCP_MAX_BUFFER,
      env: spawnSpec.env,
      shell: spawnSpec.shell,
      windowsHide: true,
      ...(spawnSpec.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
    });
    return { ok: true, stdout };
  } catch (error) {
    // codex prints PATH-alias warnings to stderr even on success; on failure
    // the CLI explains why on stderr, so prefer that over the generic error.
    return {
      ok: false,
      error: trimString(error?.stderr || error?.message || 'codex mcp failed'),
    };
  }
}

export async function listCodexMcpServers(options = {}) {
  const result = await runCodexMcp(['mcp', 'list', '--json'], options);
  if (!result.ok) {
    return { ok: false, error: result.error, servers: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const servers = Array.isArray(parsed) ? parsed : [];
    return { ok: true, servers };
  } catch {
    return { ok: false, error: 'codex mcp list returned invalid json', servers: [] };
  }
}

export async function addCodexMcpServer(
  { name, command = '', args = [], url = '', env = {} },
  options = {},
) {
  const serverName = trimString(name);
  if (!serverName) {
    return { ok: false, error: 'name is required' };
  }
  const cliArgs = ['mcp', 'add', serverName];
  const serverUrl = trimString(url);
  if (serverUrl) {
    cliArgs.push('--url', serverUrl);
  } else {
    const commandLine = trimString(command);
    if (!commandLine) {
      return { ok: false, error: 'command or url is required' };
    }
    // --env entries only apply to stdio servers.
    for (const [key, value] of Object.entries(env || {})) {
      const envKey = trimString(key);
      const envValue = trimString(String(value));
      if (envKey && envValue) {
        cliArgs.push('--env', `${envKey}=${envValue}`);
      }
    }
    cliArgs.push('--', ...(options.exactCommand ? [commandLine] : commandLine.split(/\s+/).filter(Boolean)), ...args.map(String).filter(Boolean));
  }
  const result = await runCodexMcp(cliArgs, options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

export async function removeCodexMcpServer({ name }, options = {}) {
  const serverName = trimString(name);
  if (!serverName) {
    return { ok: false, error: 'name is required' };
  }
  const result = await runCodexMcp(['mcp', 'remove', serverName], options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}
