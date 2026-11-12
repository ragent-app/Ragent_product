import { rmdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { buildSandboxedSpawn, requireSandboxAvailability } from '../lib/runner-sandbox.mjs';

function contained(root, child) {
  const part = relative(resolve(root), resolve(child));
  return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Wrap each local account MCP in the same read-only boundary as the Run. */
export async function prepareReadOnlyCodexMcp({ servers, cwd, workspace, hidePaths,
  sandboxBuilder = buildSandboxedSpawn, requireSandbox = requireSandboxAvailability, readOnly = true } = {}) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)
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
    for (const [name, raw] of Object.entries(servers)) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)
          || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError('Invalid Codex MCP server');
      }
      const command = raw.command;
      const url = raw.url;
      if (command !== undefined && command !== null) {
        if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/.test(command)
            || (url !== undefined && url !== null) || (raw.environment_id !== undefined && raw.environment_id !== null && raw.environment_id !== 'local')
            || (raw.args !== undefined && raw.args !== null && (!Array.isArray(raw.args)
              || raw.args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))))) {
          throw new TypeError('Invalid local Codex MCP server');
        }
        const sandbox = sandboxBuilder({ command, args: raw.args || [], cwd, readOnly, hidePaths,
          bindReadOnlyPaths: readOnly ? [workspace] : [], readOnlyProviderFamily: readOnly ? 'codex' : '' });
        directories.push(sandbox.emptyDir);
        const separator = sandbox.args.indexOf('--');
        if (separator < 0) throw new Error('Invalid Codex MCP sandbox');
        const privateHome = readOnly ? [] : ['--perms', '0700', '--dir', '/tmp/agentoc-executor',
          '--perms', '0700', '--dir', '/tmp/agentoc-executor/home', '--perms', '0700', '--dir', '/tmp/agentoc-executor/codex',
          '--setenv', 'HOME', '/tmp/agentoc-executor/home', '--setenv', 'CODEX_HOME', '/tmp/agentoc-executor/codex',
          '--setenv', 'AGENTOC_CODEX_HOME_DIR', '/tmp/agentoc-executor/codex',
          '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp'];
        sandbox.args.splice(separator, 0, '--die-with-parent', ...privateHome);
        // config/read includes normalized defaults which cannot necessarily be
        // written back as TOML values. Override only the launch fields; Codex
        // merges the remaining account config (including environment) itself.
        mcpServers[name] = { command: sandbox.command, args: sandbox.args };
      } else {
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
