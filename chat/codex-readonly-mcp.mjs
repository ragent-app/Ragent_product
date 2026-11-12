import { rmdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { buildSandboxedSpawn, requireSandboxAvailability } from '../lib/runner-sandbox.mjs';

function contained(root, child) {
  const part = relative(resolve(root), resolve(child));
  return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Wrap each local account MCP in the same read-only boundary as the Run. */
export async function prepareReadOnlyCodexMcp({ servers, cwd, workspace, hidePaths,
  sandboxBuilder = buildSandboxedSpawn, requireSandbox = requireSandboxAvailability, readOnly = true, runnerHome = '', additionalServers = {} } = {}) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)
      || !additionalServers || typeof additionalServers !== 'object' || Array.isArray(additionalServers)
      || ![cwd, workspace].every(path => typeof path === 'string' && isAbsolute(path) && !/[\0\r\n]/.test(path))
      || typeof readOnly !== 'boolean' || !contained(workspace, cwd) || !Array.isArray(hidePaths) || !hidePaths.length
      || hidePaths.some(path => typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path) || contained(path, cwd))) {
    throw new TypeError('Invalid read-only Codex MCP configuration');
  }
  if (requireSandbox({ required: true }) !== true) throw new Error('Read-only Codex MCP requires an available sandbox');
  const directories = [];
  const cleanup = async () => { await Promise.all(directories.map(path => rmdir(path).catch(() => {}))); };
  try {
    const mcpServers = Object.create(null);
    const entries = [...Object.entries(servers), ...Object.entries(additionalServers)];
    const seen = new Set();
    for (const [name, raw] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)
          || seen.has(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError('Invalid Codex MCP server');
      }
      seen.add(name);
      const additional = Object.hasOwn(additionalServers, name);
      const command = raw.command;
      const url = raw.url;
      if (command !== undefined && command !== null) {
        if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/.test(command)
            || (url !== undefined && url !== null) || (raw.environment_id !== undefined && raw.environment_id !== null && raw.environment_id !== 'local')
            || (raw.args !== undefined && raw.args !== null && (!Array.isArray(raw.args)
              || raw.args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))))) {
          throw new TypeError('Invalid local Codex MCP server');
        }
        const sandbox = sandboxBuilder({ command, args: raw.args || [], cwd, readOnly, hidePaths, runnerHome: readOnly ? '' : runnerHome,
          bindReadOnlyPaths: readOnly ? [workspace] : [], readOnlyProviderFamily: readOnly ? 'codex' : '' });
        directories.push(sandbox.emptyDir);
        const separator = sandbox.args.indexOf('--');
        if (separator < 0) throw new Error('Invalid Codex MCP sandbox');
        const privateHome = readOnly ? [] : ['--perms', '0700', '--dir', '/tmp/agentoc-executor',
          '--perms', '0700', '--dir', '/tmp/agentoc-executor/codex', '--setenv', 'CODEX_HOME', '/tmp/agentoc-executor/codex',
          '--setenv', 'AGENTOC_CODEX_HOME_DIR', '/tmp/agentoc-executor/codex',
          ...(typeof runnerHome === 'string' && isAbsolute(runnerHome) ? ['--setenv', 'HOME', runnerHome] : []),
          '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp'];
        sandbox.args.splice(separator, 0, '--die-with-parent', ...privateHome);
        // config/read includes normalized defaults which cannot necessarily be
        // written back as TOML values. Override only the launch fields; Codex
        // merges the remaining account config (including environment) itself.
        const env = additional && raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
          ? Object.entries(raw.env) : [];
        if (additional && raw.env != null && (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env))) {
          throw new TypeError('Invalid scoped Codex MCP environment');
        }
        if (env.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
            || typeof value !== 'string' || value.length > 16384 || value.includes('\0'))) {
          throw new TypeError('Invalid scoped Codex MCP environment');
        }
        mcpServers[name] = { command: sandbox.command, args: sandbox.args,
          ...(env.length ? { env: Object.fromEntries(env) } : {}) };
      } else {
        if (additional) throw new TypeError('Scoped Codex MCP must use a local command');
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /[\0\r\n]/.test(url)) {
          throw new TypeError('Invalid remote Codex MCP server');
        }
        // The existing remote entry remains in the account configuration.
      }
    }
    return { config: { mcp_servers: mcpServers }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
