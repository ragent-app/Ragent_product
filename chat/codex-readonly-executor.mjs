import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rmdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { buildSandboxedSpawn, requireSandboxAvailability } from '../lib/runner-sandbox.mjs';

const EXECUTOR_ENV_KEYS = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'USER', 'LOGNAME', 'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

function contained(parent, child) {
  const part = relative(resolve(parent), resolve(child));
  return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Start one credential-free, read-only executor for a shared Codex Run. */
export async function startReadOnlyCodexExecutor({ command, cwd, workspace, hidePaths, env = process.env,
  spawnImpl = spawn, sandboxBuilder = buildSandboxedSpawn, requireSandbox = requireSandboxAvailability,
  timeoutMs = 15_000, readOnly = true } = {}) {
  if (![command, cwd, workspace].every(value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value))
      || !contained(workspace, cwd) || !Array.isArray(hidePaths) || !hidePaths.length
      || typeof readOnly !== 'boolean' || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000
      || hidePaths.some(path => typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)
        || contained(path, cwd))) {
    throw new TypeError('A read-only Codex executor requires a contained workspace and protected paths');
  }
  if (requireSandbox({ required: true }) !== true) throw new Error('Read-only Codex executor requires an available sandbox');
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const sandbox = sandboxBuilder({ command, cwd, readOnly, hidePaths, bindReadOnlyPaths: readOnly ? [workspace] : [],
    readOnlyProviderFamily: readOnly ? 'codex' : '', args: ['exec-server', '--listen', 'ws://127.0.0.1:0',
      '--ws-auth', 'capability-token', '--ws-token-sha256', tokenHash] });
  // Bubblewrap terminates the executor when the owning sidecar disappears.
  const separator = sandbox.args.indexOf('--');
  if (separator < 0) { await rmdir(sandbox.emptyDir).catch(() => {}); throw new Error('Invalid executor sandbox'); }
  const privateHome = readOnly ? [] : ['--perms', '0700', '--dir', '/tmp/agentoc-executor',
    '--perms', '0700', '--dir', '/tmp/agentoc-executor/home', '--perms', '0700', '--dir', '/tmp/agentoc-executor/codex',
    '--setenv', 'HOME', '/tmp/agentoc-executor/home', '--setenv', 'CODEX_HOME', '/tmp/agentoc-executor/codex',
    '--setenv', 'AGENTOC_CODEX_HOME_DIR', '/tmp/agentoc-executor/codex',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp'];
  sandbox.args.splice(separator, 0, '--die-with-parent', ...privateHome);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) => EXECUTOR_ENV_KEYS.has(key)
    && typeof value === 'string' && !value.includes('\0')));
  let child;
  try {
    child = spawnImpl(sandbox.command, sandbox.args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    await rmdir(sandbox.emptyDir).catch(() => {});
    throw error;
  }
  let closed = false;
  const cleanup = () => rmdir(sandbox.emptyDir).catch(() => {});
  child.on('error', () => {});
  child.once('exit', () => { void cleanup(); });
  const stop = async () => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolveExit => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 5_000);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
        if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolveExit(); }
      });
    }
    await cleanup();
  };
  try {
    const endpoint = await new Promise((resolveEndpoint, reject) => {
      let buffer = '', finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        child.stdout.off('data', onData); child.off('error', onError); child.off('exit', onExit);
        if (error) reject(error); else resolveEndpoint(value);
      };
      const onError = () => finish(new Error('Codex read-only executor could not start'));
      const onExit = () => finish(new Error('Codex read-only executor exited before becoming ready'));
      const onData = chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 4096) return finish(new Error('Codex executor produced an invalid endpoint'));
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        try {
          const url = new URL(line);
          if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 0
              || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
          finish(null, url.toString());
        } catch { finish(new Error('Codex executor produced an invalid endpoint')); }
      };
      const timer = setTimeout(() => finish(new Error('Codex read-only executor startup timed out')), timeoutMs);
      timer.unref?.();
      child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit);
    });
    return { execServerUrl: endpoint, authBearerToken: token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
