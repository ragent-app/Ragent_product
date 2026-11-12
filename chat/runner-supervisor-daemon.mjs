#!/usr/bin/env node
import { spawn as spawnProcess } from 'child_process';
import { realpathSync } from 'fs';
import { chmod, mkdir, rm } from 'fs/promises';
import { createServer } from 'net';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import {
  E_CLI_SOCKET_UNSAFE,
  E_SOCKET_ALREADY_ACTIVE,
  mayRemoveStaleSocket,
  probeCliSocketPath,
  recordSocketIdentity,
  shouldCleanupSocket,
} from '../lib/cli-socket-guard.mjs';
import {
  RUNNER_SUPERVISOR_SOCKET_UNIT,
  inheritedSocketFd,
} from '../lib/systemd-socket-activation.mjs';
import {
  DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
  buildDetachedRunnerEnvironment,
} from './run-launcher.mjs';
import { nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';
import { resolveRunnerProxyEnvironment } from '../lib/network-proxy.mjs';
import { watchWindowsServiceStop } from '../lib/windows-service-stop.mjs';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';
import { assertRunLaunchBoundary } from './run-execution-boundary.mjs';
import { bindWindowsRunExecutionIdentity } from './windows-run-identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerEntry = join(__dirname, 'runner-sidecar.mjs');
// Same-user default: postinst runs the supervisor daemon and sidecars as the
// configured control-plane service user so legacy worktrees remain usable.
// Its socket still lives in the separate runner state root /var/lib/agentoc-run
// and is systemd-owned; control-plane paths remain masked by the unit. Export
// for the boundary tests.
export const DEFAULT_SUPERVISOR_SOCKET_PATH = '/var/lib/agentoc-run/runner-supervisor.sock';
const DEFAULT_SOCKET_PATH = DEFAULT_SUPERVISOR_SOCKET_PATH;
const MAX_REQUEST_BYTES = 16 * 1024;

function isMainModule(candidate, current) {
  if (!candidate) return false;
  try {
    // The Windows installer runs this file through the `current` junction,
    // while import.meta.url resolves the version directory behind it.
    return realpathSync.native(candidate) === realpathSync.native(current);
  } catch {
    return resolve(candidate) === resolve(current);
  }
}

function isWindowsNamedPipePath(socketPath) {
  return process.platform === 'win32' && /^\\\\\.\\pipe\\/i.test(String(socketPath || '').trim());
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRunId(value) {
  const runId = trimString(value);
  return /^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ? runId : '';
}

export function validateScopedProviderHomesDir(value, {
  providerHomesRoot = process.env.AGENTOC_PROVIDER_HOMES_DIR,
} = {}) {
  const candidate = trimString(value);
  const root = trimString(providerHomesRoot);
  if (!candidate) return '';
  if (!root) throw new Error('Provider homes root is not configured');
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const parts = relative(resolvedRoot, resolvedCandidate).split(sep);
  const isProviderHome = parts.length === 2
    && parts[0] === 'by-provider'
    && /^[a-f0-9]{32}$/.test(parts[1]);
  const isProviderRunHome = parts.length === 4
    && parts[0] === 'by-provider'
    && /^[a-f0-9]{32}$/.test(parts[1])
    && parts[2] === 'by-run'
    && /^[a-f0-9]{32}$/.test(parts[3]);
  const isProviderAccountHome = parts.length === 4
    && parts[0] === 'by-provider'
    && /^[a-f0-9]{32}$/.test(parts[1])
    && parts[2] === 'by-account'
    && /^[a-f0-9]{32}$/.test(parts[3]);
  const isAgyRunHome = parts.length === 2
    && parts[0] === 'by-run'
    && /^run_[A-Za-z0-9_-]{8,128}$/.test(parts[1]);
  if (!isProviderHome && !isProviderRunHome && !isProviderAccountHome && !isAgyRunHome) {
    throw new Error('Invalid scoped Provider homes directory');
  }
  return resolvedCandidate;
}

function sendResponse(socket, payload) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(payload)}\n`);
}

export async function spawnSupervisedRunner(runId, {
  spawnImpl = spawnProcess,
  processExecPath = process.execPath,
  runnerScriptPath = runnerEntry,
  providerHomesDir = '',
  codexRolloutSources = [],
  oauthLockPath = '',
  oauthLockToken = '',
  platform = process.platform,
  assertExecutionIdentityImpl = assertOrdinaryWindowsExecutionIdentity,
  assertExecutionBoundaryImpl = assertRunLaunchBoundary,
  bindWindowsExecutionIdentityImpl = bindWindowsRunExecutionIdentity,
  resolveRunnerProxyEnvironmentImpl = resolveRunnerProxyEnvironment,
} = {}) {
  const identity = await assertExecutionIdentityImpl({ platform });
  await assertExecutionBoundaryImpl(runId);
  if (platform === 'win32' && identity?.sid) {
    // Missing identity binding disables user-scoped managed execution. Do not
    // break an otherwise valid chat run when this optional feature is absent.
    try { await bindWindowsExecutionIdentityImpl(runId, identity); }
    catch (error) { console.error(`[runner-supervisor] Windows Run identity binding unavailable: ${error?.message || 'unknown error'}`); }
  }
  const proxyEnv = await resolveRunnerProxyEnvironmentImpl();
  const env = buildDetachedRunnerEnvironment({
    launchMode: DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
    proxyEnv,
  });
  env.AGENTOC_CODEX_ROLLOUT_SOURCES = JSON.stringify(codexRolloutSources);
  if (providerHomesDir) {
    env.AGENTOC_PROVIDER_HOMES_DIR = providerHomesDir;
    // The supervisor receives only a validated provider-home root over its
    // socket. Bind the AgY HOME from that root so Windows and fallback paths
    // use the same per-Run directory as the control-plane preparation.
    env.AGENTOC_AGY_HOME_DIR = join(providerHomesDir, 'agy');
  }
  if (oauthLockPath || oauthLockToken) {
    if (!oauthLockPath || !oauthLockToken) {
      throw new Error('Native OAuth lock handoff is incomplete');
    }
    env.AGENTOC_NATIVE_OAUTH_LOCK_PATH = oauthLockPath;
    env.AGENTOC_NATIVE_OAUTH_LOCK_TOKEN = oauthLockToken;
  }
  // Proxy discovery can wait beyond a temporary control grant. The sidecar
  // process must be admitted again at its actual creation boundary.
  await assertExecutionBoundaryImpl(runId);
  const child = spawnImpl(processExecPath, [runnerScriptPath, runId], {
    // Windows terminates non-detached descendants when their parent process
    // exits. The supervisor is a broker, not the Run owner: a broker crash
    // must leave the sidecar alive so it can finish and close its Job Object.
    // Linux keeps the existing cgroup/systemd ownership semantics.
    detached: platform === 'win32',
    stdio: 'ignore',
    env,
  });
  child.unref?.();
  return {
    pid: child.pid ?? null,
    launchMode: DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
  };
}

export async function createRunnerSupervisorServer({
  socketPath = process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET || DEFAULT_SOCKET_PATH,
  providerHomesRoot = process.env.AGENTOC_PROVIDER_HOMES_DIR,
  spawnRunner = spawnSupervisedRunner,
  inheritFd = null,
  inheritedSocketFdImpl = inheritedSocketFd,
} = {}) {
  const normalizedSocketPath = trimString(socketPath);
  if (!normalizedSocketPath) throw new Error('Runner supervisor socket path is required');
  const windowsNamedPipe = isWindowsNamedPipePath(normalizedSocketPath);

  // P2-C: when systemd pre-bound our socket (agentoc-runner-supervisor.socket),
  // accept the inherited listening fd instead of creating the socket file
  // ourselves.  The systemd-owned socket survives daemon restarts, so launches
  // never hit ECONNREFUSED during a Restart=always restart.
  const inherited = inheritFd ?? inheritedSocketFdImpl({ expectedName: RUNNER_SUPERVISOR_SOCKET_UNIT });

  if (!inherited && !windowsNamedPipe) {
    await mkdir(dirname(normalizedSocketPath), { recursive: true });

    // P1-B: never unlink a live supervisor socket.  Probe the existing path and
    // only ever remove a stale socket after proving it is owned by this uid.
    const probe = await probeCliSocketPath(normalizedSocketPath, { connectTimeoutMs: 300 });
    if (probe.action === 'active') {
      throw new Error(
        `Another runner supervisor owns ${normalizedSocketPath} (${E_SOCKET_ALREADY_ACTIVE}); refusing to start`,
      );
    }
    if (probe.action === 'error') {
      throw new Error(
        `Refusing to touch runner supervisor socket ${normalizedSocketPath}: ${probe.message} (${probe.code})`,
      );
    }
    if (probe.action === 'removeStale') {
      const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (!mayRemoveStaleSocket(probe.stats, { expectedUid })) {
        throw new Error(
          `Stale runner supervisor socket ${normalizedSocketPath} is not owned by this user; refusing to remove (${E_CLI_SOCKET_UNSAFE})`,
        );
      }
      await rm(normalizedSocketPath, { force: true });
    }
  }

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        sendResponse(socket, { ok: false, error: 'Runner supervisor request is too large' });
        return;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newlineIndex));
      } catch {
        sendResponse(socket, { ok: false, error: 'Invalid runner supervisor request' });
        return;
      }
      if (request?.type === 'health') {
        sendResponse(socket, { ok: true, status: 'ready' });
        return;
      }
      const runId = normalizeRunId(request?.runId);
      if (request?.type !== 'launch' || !runId) {
        sendResponse(socket, { ok: false, error: 'Invalid runner launch request' });
        return;
      }
      try {
        const providerHomesDir = validateScopedProviderHomesDir(request?.providerHomesDir || '', {
          providerHomesRoot,
        });
        if (request?.codexRolloutSources !== undefined && !Array.isArray(request.codexRolloutSources)) {
          throw new Error('Invalid Codex rollout sources');
        }
        const codexRolloutSources = (request?.codexRolloutSources || []).map((source) => {
          const validated = validateScopedProviderHomesDir(source, { providerHomesRoot });
          const parts = relative(resolve(providerHomesRoot), validated).split(sep);
          if (parts[0] !== 'by-provider' || (parts.length !== 2 && !(parts.length === 4 && parts[2] === 'by-account'))) {
            throw new Error('Invalid Codex rollout source home');
          }
          return validated;
        });
        const requestedLockPath = trimString(request?.oauthLockPath);
        const requestedLockToken = trimString(request?.oauthLockToken);
        if (requestedLockPath || requestedLockToken) {
          if (!requestedLockPath || !requestedLockToken || !providerHomesDir) {
            throw new Error('Native OAuth lock handoff is incomplete');
          }
          const expectedLockPath = nativeOAuthLockPath(providerHomesDir);
          if (!expectedLockPath || resolve(requestedLockPath) !== resolve(expectedLockPath)) {
            throw new Error('Native OAuth lock path does not match the scoped Provider home');
          }
        }
        const launched = await spawnRunner(runId, {
          providerHomesDir,
          ...(codexRolloutSources.length ? { codexRolloutSources } : {}),
          ...(requestedLockPath && requestedLockToken
            ? { oauthLockPath: requestedLockPath, oauthLockToken: requestedLockToken }
            : {}),
        });
        sendResponse(socket, {
          ok: true,
          pid: launched?.pid ?? null,
          launchMode: DETACHED_RUNNER_SUPERVISOR_LAUNCH_MODE,
        });
      } catch (error) {
        sendResponse(socket, {
          ok: false,
          error: error?.message || String(error),
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        });
      }
    });
    socket.on('error', () => {});
  });

  if (inherited) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ fd: inherited.fd }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } else {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(normalizedSocketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    // Unix sockets need an explicit group mode because the control plane and
    // supervisor may use different service identities. Windows Named Pipes
    // inherit the creating user's token ACL and do not have a chmod-able inode.
    if (!windowsNamedPipe) await chmod(normalizedSocketPath, 0o660);
  }
  const socketIdentity = inherited || windowsNamedPipe ? null : recordSocketIdentity(normalizedSocketPath);

  return {
    server,
    socketPath: normalizedSocketPath,
    inherited: !!inherited,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      // P2-C: a systemd-pre-bound socket is systemd's to remove; only unlink the
      // socket this process created (and only when it still owns the inode — a
      // replacement instance's socket is never touched).
      if (!inherited && !windowsNamedPipe && shouldCleanupSocket(normalizedSocketPath, socketIdentity)) {
        await rm(normalizedSocketPath, { force: true });
      }
    },
  };
}

async function main() {
  const supervisor = await createRunnerSupervisorServer();
  let stopWindowsServiceStopWatcher = () => {};
  const shutdown = async () => {
    stopWindowsServiceStopWatcher();
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await supervisor.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  stopWindowsServiceStopWatcher = watchWindowsServiceStop({ onStop: shutdown });
  console.log(`[runner-supervisor] listening on ${supervisor.socketPath}`);
}

if (isMainModule(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[runner-supervisor] ${error?.stack || error?.message || String(error)}`);
    process.exit(1);
  });
}
