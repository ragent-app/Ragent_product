#!/usr/bin/env node

// One Codex app-server process per machine-local provider home.
//
// Codex OAuth refresh tokens rotate on use. Starting one app-server per Run
// gives every process a copy of the same refresh token and eventually causes
// "refresh token was already used". This broker owns the provider home and
// multiplexes independent Codex threads over that one authenticated process.
// The Run sidecar still owns its own stdin/stdout and approval state; only the
// provider protocol transport is shared. The broker is scoped to one prepared
// provider home on one machine; it is never part of peer synchronization.

import { createHash } from 'node:crypto';
import { WORKBENCH_EXECUTION_POLICY, buildWorkbenchCodexEnvironment, constrainCodexBrokerRequest } from '../lib/workbench-execution-policy.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect, createServer } from 'node:net';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, unlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';
import { assertCodexHomeNotFenced } from '../lib/provider-runtime/codex-home-fence.mjs';
import { spawnManagedProviderProcess } from '../lib/windows-managed-spawn.mjs';
import { buildSharedCodexProcessEnvironment } from './codex-shared-environment.mjs';
import { createCodexWindowsHookRouter } from './codex-windows-hook-router.mjs';
import { MAC_CLEANUP_NOTIFICATION, MAC_CLEANUP_SPOOL_TYPE } from './macos-codex-cancellation.mjs';
import { createCodexBrokerTurnActivity } from './codex-broker-turn-activity.mjs';
import { secureWindowsCodexBrokerPipe } from './codex-windows-broker-pipe-security.mjs';

const BROKER_PING = 'ragent-codex-broker-ping';
const BROKER_PONG = 'ragent-codex-broker-pong';
const BROKER_READY_TIMEOUT_MS = 30_000;
const BROKER_LOCK_WAIT_MS = 15_000;
const BROKER_INTERNAL_INITIALIZE_ID = -1;

export function codexBrokerAccountDigest(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id ? createHash('sha256').update(`ragent-codex-account:${id}`).digest('hex') : '';
}

export function codexBrokerPolicyDigest(policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return '';
  const keys = Object.keys(policy).sort();
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(keys.map(key => [key, policy[key]])))).digest('hex');
}

// Bind the absence of a workbench policy as well as an active policy.
export function codexBrokerPolicyBindingDigest(policy = WORKBENCH_EXECUTION_POLICY) {
  return codexBrokerPolicyDigest(policy) || createHash('sha256').update('null').digest('hex');
}

function codexAuthAccountId(tokens) {
  for (const key of ['account_id', 'accountId', 'account_uuid', 'accountUuid', 'user_id', 'userId']) {
    if (typeof tokens?.[key] === 'string' && tokens[key].trim()) return tokens[key].trim();
  }
  return '';
}

// Each run owns a separate broker client and supplies its tag as a scoped
// thread environment. Never derive it from an interrupt request itself.
export function codexThreadRunTag(message) {
  if (!['thread/start', 'thread/resume'].includes(message?.method)) return '';
  const value = message?.params?.config?.shell_environment_policy?.set?.RAGENT_RUN_ID;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : '';
}

const MAC_CLEANUP_HELPER = join(dirname(process.execPath), 'ragent-macos-run-cleanup');

export function captureMacCodexIdentity(rootPid, {
  platform = process.platform, executable = MAC_CLEANUP_HELPER, run = spawnSync,
} = {}) {
  if (platform !== 'darwin' || !Number.isSafeInteger(rootPid) || rootPid <= 1) return null;
  try {
    const result = run(executable, ['--identity', String(rootPid)], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 });
    const match = typeof result.stdout === 'string' && /^(\d{1,20}) (\d{1,6})\n$/.exec(result.stdout);
    if (result.error || result.status !== 0 || !match || Number(match[2]) >= 1000000) return null;
    return { seconds: match[1], microseconds: match[2] };
  } catch { return null; }
}

export function cleanupMacCodexRun(rootPid, runTag, {
  platform = process.platform,
  executable = MAC_CLEANUP_HELPER,
  identity = null,
  run = spawnSync,
} = {}) {
  if (platform !== 'darwin' || !Number.isSafeInteger(rootPid) || rootPid <= 1 ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(runTag) || !/^\d{1,20}$/.test(identity?.seconds || '') ||
      !/^\d{1,6}$/.test(identity?.microseconds || '') || Number(identity.microseconds) >= 1000000) return false;
  try {
    const result = run(executable, [String(rootPid), runTag, identity.seconds, identity.microseconds], { stdio: 'ignore', timeout: 5000 });
    return !result.error && result.status === 0;
  } catch { return false; }
}

export const CODEX_APP_SERVER_BROKER_SCRIPT = fileURLToPath(import.meta.url);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSocketPath(value) {
  const path = trimString(value);
  return path && !path.includes('\0') && !/[\r\n]/.test(path) ? path : '';
}

function isWindowsNamedPipePath(value) {
  return /^\\\\\.\\pipe\\/i.test(String(value || '').trim());
}

export function buildCodexAppServerBrokerSocketPath(codexHomeDir, {
  platform = process.platform,
} = {}) {
  const home = trimString(codexHomeDir);
  if (!home) return '';
  const digest = createHash('sha256').update(platform === 'win32' ? home.toLowerCase() : home).digest('hex').slice(0, 32);
  if (platform === 'win32') {
    return `\\\\.\\pipe\\ragent-codex-${digest}`;
  }
  const providerLocalPath = join(home, '.ragent-codex-app-server.sock');
  // Linux sockaddr_un paths are capped at 108 bytes (macOS is lower). Native
  // provider homes include a hashed by-provider segment and can exceed that
  // limit under long config/test roots. Only shorten paths that cannot have a
  // working legacy broker, so live short-path brokers keep their identity.
  if (Buffer.byteLength(providerLocalPath, 'utf8') <= 100) return providerLocalPath;
  // Linux control, lifecycle and runner processes have different UIDs and
  // private /tmp mounts. Their configured provider root is shared and scoped
  // to this instance; include the complete home in the digest for isolation.
  const marker = '/by-provider/';
  const markerIndex = home.indexOf(marker);
  const sharedRoot = markerIndex > 0 ? home.slice(0, markerIndex) : trimString(process.env.RAGENT_PROVIDER_HOMES_DIR);
  if (platform === 'linux' && isAbsolute(sharedRoot)) {
    const within = relative(sharedRoot, home);
    if (within && !within.startsWith('..') && !isAbsolute(within)) {
      const sharedPath = join(sharedRoot, `.ac-${digest}.sock`);
      if (Buffer.byteLength(sharedPath, 'utf8') > 100) throw new Error('Shared Codex broker socket path is too long');
      return sharedPath;
    }
  }
  const userId = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const temporaryPath = join(tmpdir(), `ragent-codex-${userId}-${digest}.sock`);
  return Buffer.byteLength(temporaryPath, 'utf8') <= 100
    ? temporaryPath
    : join('/tmp', `ragent-codex-${userId}-${digest}.sock`);
}

export function codexAppServerBrokerSocketPath(codexHomeDir) {
  return buildCodexAppServerBrokerSocketPath(codexHomeDir);
}

export function codexAppServerBrokerLockPath(codexHomeDir) {
  const home = trimString(codexHomeDir);
  return home ? join(home, '.ragent-codex-app-server.lock') : '';
}

function brokerLockPath(socketPath, explicitLockPath = '') {
  const explicit = normalizeSocketPath(explicitLockPath);
  if (explicit) return explicit;
  if (isWindowsNamedPipePath(socketPath)) {
    const digest = createHash('sha256').update(socketPath).digest('hex').slice(0, 32);
    return join(tmpdir(), `ragent-codex-broker-${digest}.lock`);
  }
  return `${socketPath}.lock`;
}

function toSpawnEnvironment(environment = {}) {
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined && value !== null),
  );
}

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? trimString(process.argv[index + 1]) || fallback : fallback;
}

function writeLine(socket, value) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(`${JSON.stringify(value)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function probeBroker(socketPath, timeoutMs = 1_500, { failOnAccessDenied = false, expectedPolicyDigest = '', expectedAccountDigest = '', expectedUid = null, requireConclusive = false, pendingMayWait = false } = {}) {
  const normalized = normalizeSocketPath(socketPath);
  if (!normalized) return false;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = connect(normalized);
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready === true);
    };
    const uncertain = (detail = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const error = new Error(`Cannot establish whether the existing Codex broker at ${normalized} is active${detail}; do not remove its socket or restart it until active Runs and the broker process have been verified`);
      error.code = 'CODEX_BROKER_STATE_UNCERTAIN';
      reject(error);
    };
    const timer = setTimeout(() => requireConclusive ? uncertain() : finish(false), Math.max(100, timeoutMs));
    timer.unref?.();
    socket.on('error', (error) => {
      if (failOnAccessDenied && ['EACCES', 'EPERM'].includes(error?.code)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        const denied = new Error('The Codex broker endpoint cannot be accessed by this process. Check the service identities and endpoint permissions before restarting the broker.');
        denied.code = 'CODEX_APP_SERVER_BROKER_ACCESS_DENIED';
        reject(denied);
        return;
      }
      if (requireConclusive && error?.code !== 'ENOENT') {
        return uncertain(error?.code === 'ECONNREFUSED'
          ? ' (the socket refused a connection; its ownership and the upstream process are unverified)'
          : '');
      }
      finish(false);
    });
    socket.on('end', () => { if (requireConclusive) uncertain(); else finish(false); });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message?.type === BROKER_PONG && message.ready === false && pendingMayWait) {
            finish(false);
            return;
          }
          if (message?.type === BROKER_PONG && message.ready === true) {
            if ((expectedPolicyDigest && message.policyDigest !== expectedPolicyDigest)
                || (expectedAccountDigest && message.accountMatches !== true)
                || (expectedUid !== null && message.uid !== expectedUid)) {
              if (settled) return;
              settled = true; clearTimeout(timer); socket.destroy();
              const error = new Error('The existing Codex broker does not match the required account, policy, or service identity. Verify its process and ensure no Runs are active before a controlled restart');
              error.code = 'CODEX_BROKER_BINDING_MISMATCH'; reject(error); return;
            }
            finish(true);
          }
        } catch {}
      }
    });
    socket.once('connect', () => writeLine(socket, { type: BROKER_PING, ...(expectedAccountDigest ? { expectedAccountDigest } : {}) }));
  });
}

export async function isCodexAppServerBrokerReady(socketPath, timeoutMs = 1_500, options = {}) {
  return probeBroker(socketPath, timeoutMs, options);
}

/**
 * Launch the broker-owned Codex process through the same explicit spawn
 * contract as a Run provider.  On Windows this creates the provider inside a
 * Job Object; the broker remains the long-lived owner so Control Plane
 * restarts do not terminate the authenticated app-server.
 */
export async function spawnCodexAppServerProcess({
  file,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  windowsVerbatimArguments = false,
  spawnManagedImpl = spawnManagedProviderProcess,
} = {}) {
  return spawnManagedImpl({
    file,
    args,
    cwd,
    env,
    shell: false,
    windowsVerbatimArguments: windowsVerbatimArguments === true,
  }, {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

async function waitForBroker(socketPath, timeoutMs = BROKER_READY_TIMEOUT_MS, binding = {}) {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    if (await probeBroker(socketPath, 1_500, binding)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Start the machine-local broker once and wait until its upstream Codex
 * process has completed initialize. The lock protects only broker creation;
 * it is released before the Run starts and therefore does not serialize Runs.
 */
export async function ensureCodexAppServerBroker({
  socketPath,
  upstreamFile,
  upstreamArgs = [],
  upstreamWindowsVerbatimArguments = false,
  cwd = process.cwd(),
  env = process.env,
  lockPath = '',
  scriptPath = CODEX_APP_SERVER_BROKER_SCRIPT,
  waitMs = BROKER_READY_TIMEOUT_MS,
  spawnImpl = spawn,
  acquireLockImpl = acquireNativeOAuthLock,
  assertLaunchBoundary = null,
  expectedPolicyDigest = codexBrokerPolicyBindingDigest(),
  expectedAccountDigest = '',
  expectedUid = process.platform === 'linux' ? process.getuid?.() ?? null : null,
} = {}) {
  const binding = { expectedPolicyDigest, expectedAccountDigest, expectedUid };
  const normalizedSocket = normalizeSocketPath(socketPath);
  const file = trimString(upstreamFile);
  if (!normalizedSocket || !file || !Array.isArray(upstreamArgs)) {
    const error = new Error('Codex app-server broker launch specification is incomplete');
    error.code = 'CODEX_APP_SERVER_BROKER_INVALID';
    throw error;
  }
  if (trimString(env.CODEX_HOME)) await assertCodexHomeNotFenced(dirname(env.CODEX_HOME));
  if (await probeBroker(normalizedSocket, 1_500, { failOnAccessDenied: true, requireConclusive: true, pendingMayWait: true, ...binding })) return { ok: true, socketPath: normalizedSocket, reused: true, pid: null };

  if (!isWindowsNamedPipePath(normalizedSocket)) {
    await mkdir(dirname(normalizedSocket), { recursive: true, mode: 0o770 });
  }
  let lock = null;
  let brokerPid = null;
  let brokerChild = null;
  try {
    lock = await acquireLockImpl(brokerLockPath(normalizedSocket, lockPath), {
      waitMs: BROKER_LOCK_WAIT_MS,
      pollMs: 50,
    });
    if (trimString(env.CODEX_HOME)) await assertCodexHomeNotFenced(dirname(env.CODEX_HOME));
    if (await probeBroker(normalizedSocket, 1_500, { failOnAccessDenied: true, requireConclusive: true, ...binding })) {
      return { ok: true, socketPath: normalizedSocket, reused: true, pid: null };
    }
    // Only ENOENT permits a new owner. An existing socket, including a
    // refused or unresponsive endpoint, requires verified manual handoff.
    const childEnv = {
      ...toSpawnEnvironment(env),
      RAGENT_CODEX_BROKER_SOCKET: normalizedSocket,
      RAGENT_CODEX_BROKER_UPSTREAM_FILE: file,
      RAGENT_CODEX_BROKER_UPSTREAM_ARGS: JSON.stringify(upstreamArgs),
      RAGENT_CODEX_BROKER_UPSTREAM_WINDOWS_VERBATIM: upstreamWindowsVerbatimArguments === true ? '1' : '0',
      RAGENT_CODEX_BROKER_UPSTREAM_CWD: trimString(cwd) || process.cwd(),
    };
    if (assertLaunchBoundary) await assertLaunchBoundary();
    brokerChild = spawnImpl(process.execPath, [scriptPath, '--broker'], {
      cwd: trimString(cwd) || process.cwd(),
      env: childEnv,
      stdio: 'ignore',
      detached: true,
    });
    brokerChild.unref?.();
    brokerPid = brokerChild.pid ?? null;
    // Keep creation serialized through initialize so another caller cannot
    // mistake an unready socket for permission to start a second owner.
    const ready = await waitForBroker(normalizedSocket, waitMs, binding);
    if (!ready) {
      // A readiness timeout does not prove the broker is dead or unused. A
      // caller may already have connected, so leave ownership and recovery to
      // its supervisor rather than terminating a potentially active process.
      const error = new Error('Codex app-server broker did not become ready');
      error.code = 'CODEX_APP_SERVER_BROKER_UNAVAILABLE';
      throw error;
    }
    return { ok: true, socketPath: normalizedSocket, reused: false, pid: brokerPid ?? null };
  } finally {
    await lock?.release?.();
  }
}

function initializeMessage() {
  return {
    method: 'initialize',
    id: BROKER_INTERNAL_INITIALIZE_ID,
    params: {
      clientInfo: { name: 'ragent-codex-broker', title: 'Ragent Codex broker', version: '1' },
      capabilities: {
        experimentalApi: true,
        extensions: {
          'openai/form': {},
        },
      },
    },
  };
}

function readThreadId(message) {
  const params = message?.params && typeof message.params === 'object' ? message.params : {};
  return trimString(
    params.threadId
      || params.thread?.id
      || params.turn?.threadId
      || params.item?.threadId
      || message?.threadId,
  );
}

function readResultThreadId(message) {
  return trimString(message?.result?.thread?.id || message?.result?.threadId);
}

function isRequest(message) {
  return typeof message?.id === 'string' || typeof message?.id === 'number';
}

function runBroker() {
  const socketPath = normalizeSocketPath(process.env.RAGENT_CODEX_BROKER_SOCKET || readArg('--socket'));
  const upstreamFile = trimString(process.env.RAGENT_CODEX_BROKER_UPSTREAM_FILE);
  const upstreamCwd = trimString(process.env.RAGENT_CODEX_BROKER_UPSTREAM_CWD) || process.cwd();
  const upstreamWindowsVerbatimArguments = process.env.RAGENT_CODEX_BROKER_UPSTREAM_WINDOWS_VERBATIM === '1';
  let upstreamArgs = [];
  try {
    upstreamArgs = JSON.parse(process.env.RAGENT_CODEX_BROKER_UPSTREAM_ARGS || '[]');
  } catch {}
  if (!socketPath || !upstreamFile || !Array.isArray(upstreamArgs)) {
    console.error('[codex-broker] invalid broker environment');
    process.exitCode = 1;
    return;
  }

  const clients = new Set();
  const turnActivity = createCodexBrokerTurnActivity();
  const threadOwners = new Map();
  const mcpStartupOwners = new Map();
  const releaseMcpEntry = entry => {
    for (const [name, owner] of mcpStartupOwners) if (owner === entry) mcpStartupOwners.delete(name);
  };
  const releaseMcpThread = threadId => {
    for (const [name, owner] of mcpStartupOwners) if (owner.threadId === threadId) mcpStartupOwners.delete(name);
  };
  const bindMcpEntry = entry => {
    const servers = entry.message.params?.config?.mcp_servers;
    const names = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
    if (names.some(name => mcpStartupOwners.has(name))) return false;
    for (const name of names) mcpStartupOwners.set(name, entry);
    return true;
  };
  const pending = new Map();
  // OAuth completion is app-scoped and must return only to its initiating
  // connection. Serializing by name also supports older servers without a
  // loginId and prevents ambiguous completion routing.
  const mcpOAuthOwners = new Map();
  // Server-initiated requests use a separate id namespace from client
  // requests. Keep the original upstream id for the eventual response.
  const pendingServerRequests = new Map();
  const recentServerRequestIds = new Map();
  const pendingThreadClients = [];
  const threadStartQueue = [];
  const pendingThreadReloads = new Map();
  const hookRouters = new Map();
  // Bounded diagnostic observations only; never used to authorize a hook.
  const hookObservations = [];
  const pruneHookObservations = () => {
    const cutoff = Date.now() - 60_000;
    while (hookObservations.length && hookObservations[0].at < cutoff) hookObservations.shift();
    while (hookObservations.length > 64) hookObservations.shift();
  };
  const pendingHookCalls = new Map();
  const clientRunTags = new WeakMap();
  let activeThreadRequestId = null;
  let nextRequestId = 10_000;
  let upstreamReady = false;
  let upstream = null;
  let upstreamMacIdentity = null;
  let server = null;
  let oauthLock = null;
  let accountDigest = '';
  let stopping = false;

  const sendClient = (client, message) => {
    if (!client || client.destroyed) return false;
    try {
      client.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const routeNotification = (message) => {
    if (message?.method === 'mcpServer/oauthLogin/completed') {
      const name = trimString(message.params?.name);
      const owner = mcpOAuthOwners.get(name);
      const loginId = trimString(message.params?.loginId);
      if (owner && (!owner.loginId || !loginId || owner.loginId === loginId)) {
        clearTimeout(owner.timer);
        mcpOAuthOwners.delete(name);
        sendClient(owner.client, message);
      }
      return;
    }
    const threadId = readThreadId(message);
    if (message?.method === 'serverRequest/resolved') {
      const upstreamRequestId = message.params?.requestId;
      let matchedClientId = '';
      let matchedEntry = null;
      for (const [clientReqId, entry] of pendingServerRequests.entries()) {
        if (entry.upstreamId === upstreamRequestId) {
          matchedClientId = clientReqId;
          matchedEntry = entry;
          break;
        }
      }
      if (!matchedEntry && upstreamRequestId !== undefined && upstreamRequestId !== null) {
        const targetStr = String(upstreamRequestId);
        for (const [clientReqId, entry] of pendingServerRequests.entries()) {
          if (String(entry.upstreamId) === targetStr) {
            matchedClientId = clientReqId;
            matchedEntry = entry;
            break;
          }
        }
      }
      if (matchedEntry) {
        pendingServerRequests.delete(matchedClientId);
        const targetClient = matchedEntry.client && !matchedEntry.client.destroyed
          ? matchedEntry.client
          : (threadId ? threadOwners.get(threadId) : null);
        if (targetClient) {
          sendClient(targetClient, {
            ...message,
            params: {
              ...(message.params && typeof message.params === 'object' ? message.params : {}),
              requestId: matchedClientId,
            },
          });
        }
        return;
      }
      const recentKey = upstreamRequestId === undefined || upstreamRequestId === null ? '' : String(upstreamRequestId);
      const recent = recentKey ? recentServerRequestIds.get(recentKey) : null;
      if (recent) {
        recentServerRequestIds.delete(recentKey);
        const targetClient = recent.client && !recent.client.destroyed
          ? recent.client
          : (threadId ? threadOwners.get(threadId) : null);
        if (targetClient) {
          sendClient(targetClient, {
            ...message,
            params: {
              ...(message.params && typeof message.params === 'object' ? message.params : {}),
              requestId: recent.clientRequestId,
            },
          });
        }
        return;
      }
    }
    if (message?.method === 'hook/started' && threadId) {
      pruneHookObservations();
      const owner = threadOwners.get(threadId), router = owner && hookRouters.get(owner);
      hookObservations.push({ at: Date.now(), threadId, turnId: trimString(message.params?.turnId),
        runId: trimString(message.params?.run?.id), owner: owner || null,
        ownerAtObservation: Boolean(owner && !owner.destroyed), routerAtObservation: Boolean(router),
        flags: router?.inspectStarted(message) || null });
      pruneHookObservations();
    }
    if (message?.method === 'mcpServer/startupStatus/updated' && !threadId) {
      const owner = mcpStartupOwners.get(trimString(message.params?.name || message.params?.serverName || message.params?.server_name));
      if (owner) sendClient(owner.client, message);
      return;
    }
    if (message?.method === 'hook/started' || message?.method === 'hook/completed') {
      hookRouters.get(threadOwners.get(threadId))?.observe(message);
    }
    if (threadId && threadOwners.has(threadId)) {
      sendClient(threadOwners.get(threadId), message);
      return;
    }
    if (message?.method === 'thread/started' && pendingThreadClients.length > 0) {
      const client = pendingThreadClients.shift();
      const startedId = readThreadId(message);
      if (startedId && !client.destroyed) threadOwners.set(startedId, client);
      sendClient(client, message);
      return;
    }
    // Account rate-limit updates are global provider state. They contain no
    // credential material and are useful to every active Run.
    if (message?.method === 'account/rateLimits/updated') {
      for (const client of clients) sendClient(client, message);
    }
  };

  const removePendingThreadClient = (client) => {
    const index = pendingThreadClients.lastIndexOf(client);
    if (index >= 0) pendingThreadClients.splice(index, 1);
  };

  // thread/started does not carry the initiating JSON-RPC id. Serialize only
  // thread creation/resume/fork until its response, so an out-of-order start
  // cannot assign one client's thread and approvals to another client. Turns
  // on already-created threads remain concurrent.
  const sendNextThreadRequest = () => {
    if (activeThreadRequestId !== null || !upstream?.stdin?.writable) return;
    while (threadStartQueue.length > 0) {
      const entry = threadStartQueue.shift();
      if (entry.client.destroyed) continue;
      if (entry.message.method === 'thread/resume') {
        const owner = threadOwners.get(entry.message.params?.threadId);
        if (owner && owner !== entry.client && !owner.destroyed) {
          sendClient(entry.client, { id: entry.clientId, error: { code: -32004, message: 'Codex thread is owned by another connected client' } });
          continue;
        }
      }
      activeThreadRequestId = entry.id;
      if (entry.message.method === 'thread/resume') {
        // A loaded thread retains its previous MCP config. Release it before
        // resuming so this run's capabilities and tokens take effect.
        const reloadId = nextRequestId++;
        pendingThreadReloads.set(reloadId, entry);
        try { upstream.stdin.write(`${JSON.stringify({ id: reloadId, method: 'thread/unsubscribe', params: { threadId: entry.message.params.threadId } })}\n`); } catch {}
        return;
      }
      if (!bindMcpEntry(entry)) {
        sendClient(entry.client, { id: entry.clientId, error: { code: -32007, message: 'MCP server name already owned' } });
        activeThreadRequestId = null; continue;
      }
      pending.set(entry.id, { client: entry.client, clientId: entry.clientId, mcpEntry: entry });
      pendingThreadClients.push(entry.client);
      try { upstream.stdin.write(`${JSON.stringify(entry.message)}\n`); } catch { releaseMcpEntry(entry); }
      return;
    }
  };

  const handleUpstreamMessage = (message) => {
    if (!message || typeof message !== 'object') return;
    turnActivity.upstream(message);
    const serverRequest = typeof message.method === 'string' && isRequest(message);
    if (message.method === MAC_CLEANUP_NOTIFICATION || message.type === MAC_CLEANUP_SPOOL_TYPE) {
      if (serverRequest) {
        try { upstream?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Reserved broker method' } })}\n`); } catch {}
      }
      return;
    }
    if (!serverRequest && message.id === BROKER_INTERNAL_INITIALIZE_ID) {
      upstreamReady = !message.error;
      return;
    }
    if (!serverRequest && !message.method && pendingThreadReloads.has(message.id)) {
      const entry = pendingThreadReloads.get(message.id);
      pendingThreadReloads.delete(message.id);
      if (message.error || entry.client.destroyed) {
        if (message.error) sendClient(entry.client, { id: entry.clientId, error: { code: -32005, message: 'Could not release the previous Codex thread configuration' } });
        activeThreadRequestId = null;
        sendNextThreadRequest();
        return;
      }
      releaseMcpThread(entry.message.params?.threadId);
      if (!bindMcpEntry(entry)) {
        sendClient(entry.client, { id: entry.clientId, error: { code: -32007, message: 'MCP server name already owned' } });
        activeThreadRequestId = null; sendNextThreadRequest(); return;
      }
      pending.set(entry.id, { client: entry.client, clientId: entry.clientId, mcpEntry: entry });
      pendingThreadClients.push(entry.client);
      try { upstream.stdin.write(`${JSON.stringify(entry.message)}\n`); } catch { releaseMcpEntry(entry); }
      return;
    }
    if (serverRequest) {
      if (message.method === 'ragent/windowsHook' || message.method === 'ragent/registerWindowsHook') {
        try { upstream?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Reserved broker method' } })}\n`); } catch {}
        return;
      }
      const client = threadOwners.get(readThreadId(message));
      if (!client || client.destroyed) {
        try { upstream?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'No connected owner for this thread' } })}\n`); } catch {}
        return;
      }
      const clientRequestId = `ragent-server-${nextRequestId++}`;
      pendingServerRequests.set(clientRequestId, { client, upstreamId: message.id });
      if (!sendClient(client, { ...message, id: clientRequestId })) {
        pendingServerRequests.delete(clientRequestId);
        try { upstream?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'Thread owner disconnected' } })}\n`); } catch {}
      }
      return;
    }
    if (!message.method && isRequest(message) && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request.mcpOAuthName) {
        const owner = mcpOAuthOwners.get(request.mcpOAuthName);
        if (owner?.client === request.client) {
          if (message.error) { clearTimeout(owner.timer); mcpOAuthOwners.delete(request.mcpOAuthName); }
          else owner.loginId = trimString(message.result?.loginId);
        }
      }
      const threadId = readResultThreadId(message);
      if (request.mcpEntry) {
        if (message.error || !threadId || request.client.destroyed) releaseMcpEntry(request.mcpEntry);
        else request.mcpEntry.threadId = threadId;
      }
      if (!message.error && request.releaseThreadId) releaseMcpThread(request.releaseThreadId);
      if (threadId && !request.client.destroyed) {
        threadOwners.set(threadId, request.client);
        removePendingThreadClient(request.client);
      }
      sendClient(request.client, { ...message, id: request.clientId });
      if (message.id === activeThreadRequestId) {
        removePendingThreadClient(request.client);
        activeThreadRequestId = null;
        sendNextThreadRequest();
      }
      return;
    }
    routeNotification(message);
  };

  const startUpstream = async () => {
    // Share the exact lifecycle lock used by exclusive MCP/sandbox Runs.
    // A ready broker keeps it until its real upstream exits; IPC callers
    // multiplex threads without acquiring it again.
    const home = trimString(process.env.CODEX_HOME);
    if (!home) throw new Error('Codex broker requires its managed provider home');
    oauthLock = await acquireNativeOAuthLock(nativeOAuthLockPath(dirname(home)), { waitMs: 15_000 });
    if (stopping) { await oauthLock.release(); return; }
    try { await assertCodexHomeNotFenced(dirname(home)); }
    catch (error) { await oauthLock.release(); oauthLock = null; throw error; }
    try {
      const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
      accountDigest = codexBrokerAccountDigest(codexAuthAccountId(auth?.tokens));
    } catch { accountDigest = ''; }
    try {
    upstream = await spawnCodexAppServerProcess({
      file: upstreamFile,
      args: upstreamArgs,
      cwd: upstreamCwd,
      env: buildSharedCodexProcessEnvironment(buildWorkbenchCodexEnvironment(process.env), {
        basePath: process.env.RAGENT_CODEX_BROKER_BASE_PATH || '',
      }),
      windowsVerbatimArguments: upstreamWindowsVerbatimArguments,
    });
    } catch (error) {
      await oauthLock.release();
      throw error;
    }
    upstream.on('error', (error) => {
      console.error(`[codex-broker] upstream error: ${error?.message || error}`);
      upstreamReady = false;
      for (const client of clients) client.end();
      // A spawn error has no live authenticated child.
      if (!upstream.pid) void oauthLock?.release();
    });
    const reader = createInterface({ input: upstream.stdout });
    reader.on('line', (line) => {
      try { handleUpstreamMessage(JSON.parse(line)); } catch {}
    });
    upstream.on('exit', () => {
      upstreamReady = false;
      upstreamMacIdentity = null;
      for (const client of clients) client.end();
      server?.close();
      void oauthLock?.release();
    });
    if (process.platform === 'darwin' && upstream.exitCode === null && upstream.signalCode === null) {
      upstreamMacIdentity = captureMacCodexIdentity(upstream.pid);
    }
    try { upstream.stdin.write(`${JSON.stringify(initializeMessage())}\n`); } catch {}
  };

  const waitForUpstreamExit = (timeoutMs = 5_000) => {
    if (!upstream || upstream.exitCode !== null || upstream.exitEmitted === true) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      upstream.once('exit', finish);
    });
  };

  const handleClientMessage = (client, message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ragent-codex-broker-retire') {
      const accountMatches = Boolean(accountDigest && message.expectedAccountDigest === accountDigest);
      const idle = accountMatches && upstreamReady && !stopping && clients.size === 1
        && turnActivity.isIdle() && pending.size === 0 && pendingServerRequests.size === 0
        && pendingThreadReloads.size === 0 && pendingThreadClients.length === 0
        && threadStartQueue.length === 0 && activeThreadRequestId === null
        && pendingHookCalls.size === 0 && (typeof mcpOAuthOwners === 'undefined' || mcpOAuthOwners.size === 0);
      if (!idle) {
        sendClient(client, { type: 'ragent-codex-broker-retire-result', accepted: false });
        return;
      }
      // Stop accepting connections in the same event-loop turn as the idle
      // check, so no new request can start before shutdown begins.
      stopping = true;
      server?.close();
      sendClient(client, { type: 'ragent-codex-broker-retire-result', accepted: true });
      void shutdown();
      return;
    }
    if (stopping) return;
    if (message.type === BROKER_PING) {
      sendClient(client, { type: BROKER_PONG, ready: upstreamReady, policyDigest: codexBrokerPolicyBindingDigest(),
        uid: process.platform === 'linux' ? process.getuid?.() ?? null : null,
        ...(typeof message.expectedAccountDigest === 'string'
          ? { accountMatches: Boolean(accountDigest && message.expectedAccountDigest === accountDigest) } : {}) });
      return;
    }
    if (message.method === 'initialize') {
      sendClient(client, {
        id: message.id,
        result: { serverInfo: { name: 'codex', version: 'brokered' }, capabilities: {} },
      });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'ragent/registerWindowsHook' && isRequest(message)) {
      const sourcePath = message.params?.sourcePath;
      const order = message.params?.displayOrder;
      if (typeof sourcePath !== 'string' || !sourcePath || !Number.isSafeInteger(order) || order < 0 || order > 10000) {
        sendClient(client, { id: message.id, error: { code: -32602, message: 'Invalid managed hook identity' } });
        return;
      }
      hookRouters.set(client, createCodexWindowsHookRouter({ sourcePath,
        runIdPrefix: `pre-tool-use:${order}:${sourcePath}:`, getOwner: id => threadOwners.get(id) }));
      sendClient(client, { id: message.id, result: {} });
      return;
    }
    if (message.type === 'ragent-codex-windows-hook') {
      const event = message.event;
      const deny = (code, diagnostics) => sendClient(client, { error: 'No matching active managed hook', code, ...(diagnostics ? { diagnostics } : {}) });
      const tryClaim = (remaining) => {
        if (client.destroyed) return;
        const owner = threadOwners.get(event?.session_id);
        const matched = owner && hookRouters.get(owner)?.claim(event);
        if (!matched) {
          if (remaining > 0) { const timer = setTimeout(() => tryClaim(remaining - 1), 50); timer.unref?.(); }
          else {
            pruneHookObservations();
            const router = owner && hookRouters.get(owner);
            const candidates = hookObservations.filter(entry => entry.threadId === event?.session_id && (!entry.owner || entry.owner === owner));
            const exact = candidates.filter(entry => entry.turnId && entry.turnId === event?.turn_id);
            const selected = exact.length === 1 ? exact[0] : !exact.length && candidates.length === 1 ? candidates[0] : null;
            const candidateBasis = exact.length === 1 ? 'exact-turn' : exact.length > 1 || candidates.length > 1 ? 'ambiguous' : selected ? 'thread-only' : 'none';
            const diagnostics = { candidateBasis, routerPresent: Boolean(router),
              ownerAtObservation: selected?.ownerAtObservation ?? null, routerAtObservation: selected?.routerAtObservation ?? null,
              turnPresent: selected ? Boolean(selected.turnId) : null };
            if (candidateBasis === 'exact-turn' && selected?.flags) Object.assign(diagnostics, selected.flags,
              router?.inspectClaim(event, selected.runId) || {});
            deny(!owner || owner.destroyed ? 'HOOK_OWNER_UNAVAILABLE' : 'HOOK_CLAIM_UNMATCHED', diagnostics);
          }
          return;
        }
        const id = `ragent-hook-${nextRequestId++}`;
        const timer = setTimeout(() => { pendingHookCalls.delete(id); deny('HOOK_OWNER_TIMEOUT'); }, 60_000);
        timer.unref?.();
        pendingHookCalls.set(id, { owner, client, timer });
        if (!sendClient(owner, { id, method: 'ragent/windowsHook', params: { event } })) {
          clearTimeout(timer); pendingHookCalls.delete(id); deny('HOOK_OWNER_DISCONNECTED');
        }
      };
      tryClaim(20);
      return;
    }
    if (!message.method && isRequest(message)) {
      const hookCall = pendingHookCalls.get(message.id);
      if (hookCall) {
        if (hookCall.owner !== client) return;
        clearTimeout(hookCall.timer); pendingHookCalls.delete(message.id);
        sendClient(hookCall.client, message.error ? { error: 'Hook evaluation failed', code: 'HOOK_EVALUATION_FAILED' } : { result: message.result });
        return;
      }
      const request = pendingServerRequests.get(message.id);
      if (!request || request.client !== client) return;
      pendingServerRequests.delete(message.id);
      const recentKey = String(request.upstreamId ?? '');
      if (recentKey) {
        recentServerRequestIds.set(recentKey, { client, clientRequestId: message.id });
        if (recentServerRequestIds.size > 512) {
          recentServerRequestIds.delete(recentServerRequestIds.keys().next().value);
        }
      }
      try { upstream?.stdin?.write(`${JSON.stringify({ ...message, id: request.upstreamId })}\n`); } catch {}
      return;
    }
    if (!upstreamReady || !upstream?.stdin?.writable) {
      if (isRequest(message)) sendClient(client, { id: message.id, error: { code: -32000, message: 'Codex broker upstream is not ready' } });
      return;
    }

    try { message = constrainCodexBrokerRequest(message); } catch {
      if (isRequest(message)) sendClient(client, { id: message.id, error: { code: -32003, message: 'Workbench model policy denied this request' } });
      return;
    }
    const threadId = readThreadId(message);
    const owner = threadId && threadOwners.get(threadId);
    if (owner && owner !== client && !owner.destroyed && message.method !== 'thread/fork') {
      if (isRequest(message)) sendClient(client, { id: message.id, error: { code: -32004, message: 'Codex thread is owned by another connected client' } });
      return;
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      clientRunTags.set(client, codexThreadRunTag(message));
    }
    if (process.platform === 'darwin' && message.method === 'turn/interrupt' && owner === client) {
      const runTag = clientRunTags.get(client);
      const cleanupAttempted = Boolean(runTag && upstream?.exitCode === null && upstream?.signalCode === null &&
        cleanupMacCodexRun(upstream.pid, runTag, { identity: upstreamMacIdentity }));
      sendClient(client, { method: MAC_CLEANUP_NOTIFICATION, params: {
        threadId, runId: runTag || null, status: cleanupAttempted ? 'attempted' : 'unconfirmed',
      } });
      if (!cleanupAttempted) {
        // Still send the provider interrupt. A failed cleanup must not prevent
        // cooperative cancellation; it also must not expose process details.
        console.error('[codex-broker] macOS run process cleanup was incomplete');
      }
    }
    // A fork reads its source thread; it must not take ownership of that
    // source. Ownership of the newly created thread comes from its response.
    if (threadId && message.method !== 'thread/fork' && message.method !== 'thread/resume') threadOwners.set(threadId, client);
    const startsThread = message.method === 'thread/start' || message.method === 'thread/resume' || message.method === 'thread/fork';
    const mcpOAuthName = message.method === 'mcpServer/oauth/login' ? trimString(message.params?.name) : '';
    if (message.method === 'mcpServer/oauth/login' && (!isRequest(message) || !mcpOAuthName || mcpOAuthOwners.has(mcpOAuthName))) {
      if (isRequest(message)) sendClient(client, { id: message.id, error: { code: -32006, message: 'MCP authorization is invalid or already in progress' } });
      return;
    }
    const rewritten = { ...message };
    if (isRequest(message)) {
      const upstreamId = nextRequestId;
      nextRequestId += 1;
      if (startsThread) {
        rewritten.id = upstreamId;
        threadStartQueue.push({ client, clientId: message.id, id: upstreamId, message: rewritten });
        sendNextThreadRequest();
        return;
      }
      pending.set(upstreamId, { client, clientId: message.id, ...(mcpOAuthName ? { mcpOAuthName } : {}),
        ...(message.method === 'thread/unsubscribe' && threadId ? { releaseThreadId: threadId } : {}) });
      if (mcpOAuthName) {
        const seconds = Number(message.params?.timeoutSecs);
        const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 3600;
        const owner = { client, loginId: '', timer: null };
        owner.timer = setTimeout(() => { if (mcpOAuthOwners.get(mcpOAuthName) === owner) mcpOAuthOwners.delete(mcpOAuthName); }, (lifetime + 30) * 1000);
        owner.timer.unref?.();
        mcpOAuthOwners.set(mcpOAuthName, owner);
      }
      rewritten.id = upstreamId;
    }
    turnActivity.startRequest(rewritten);
    try { upstream.stdin.write(`${JSON.stringify(rewritten)}\n`); } catch {}
  };

  const attachClient = (client) => {
    if (stopping) { client.destroy(); return; }
    clients.add(client);
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { handleClientMessage(client, JSON.parse(line)); } catch {}
      }
    });
    client.on('close', () => {
      clients.delete(client);
      const closingThreads = new Set([...threadOwners].filter(([, owner]) => owner === client).map(([id]) => id));
      for (let i = hookObservations.length - 1; i >= 0; i -= 1) {
        const entry = hookObservations[i];
        if (entry.owner === client || (!entry.owner && closingThreads.has(entry.threadId))) hookObservations.splice(i, 1);
      }
      for (const [name, owner] of mcpStartupOwners) if (owner.client === client) mcpStartupOwners.delete(name);
      // Closing the client does not cancel Codex's native OAuth flow. Retain a
      // tombstone until completion/expiry so its notification cannot be sent
      // to a later request for the same server, including older no-loginId APIs.
      for (const owner of mcpOAuthOwners.values()) if (owner.client === client) owner.client = null;
      hookRouters.delete(client);
      for (const [id, call] of pendingHookCalls) {
        if (call.client !== client && call.owner !== client) continue;
        clearTimeout(call.timer); pendingHookCalls.delete(id);
        if (call.owner === client) sendClient(call.client, { error: 'Hook owner disconnected', code: 'HOOK_OWNER_DISCONNECTED' });
      }
      for (let index = pendingThreadClients.length - 1; index >= 0; index -= 1) {
        if (pendingThreadClients[index] === client) pendingThreadClients.splice(index, 1);
      }
      for (const [threadId, owner] of threadOwners) {
        if (owner === client) threadOwners.delete(threadId);
      }
      for (const [id, request] of pending) {
        if (request.client === client && id !== activeThreadRequestId) pending.delete(id);
      }
      for (let index = threadStartQueue.length - 1; index >= 0; index -= 1) {
        if (threadStartQueue[index].client === client) threadStartQueue.splice(index, 1);
      }
      for (const [id, request] of pendingServerRequests) {
        if (request.client !== client) continue;
        pendingServerRequests.delete(id);
        try { upstream?.stdin?.write(`${JSON.stringify({ id: request.upstreamId, error: { code: -32000, message: 'Thread owner disconnected' } })}\n`); } catch {}
      }
    });
  };

  void (async () => {
    // Never unlink an endpoint here: another broker may still own it.
    server = createServer(attachClient);
    server.listen(socketPath, async () => {
      await chmod(socketPath, 0o660).catch(() => {});
      try {
        await secureWindowsCodexBrokerPipe(socketPath, process.pid, {
          serviceMode: process.env.RAGENT_CODEX_BROKER_SERVICE_MODE === '1',
        });
      } catch (error) {
        console.error(`[codex-broker] pipe security failed: ${error?.code || 'unknown'}`);
        server?.close();
        process.exitCode = 1;
        return;
      }
      void startUpstream().catch((error) => {
        console.error(`[codex-broker] upstream launch failed: ${error?.message || error}`);
        server?.close();
      });
    });
    server.on('error', (error) => {
      console.error(`[codex-broker] socket error: ${error?.message || error}`);
      process.exitCode = 1;
    });
  })();

  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopping = true;
      for (const client of clients) client.end();
      try {
        if (typeof upstream?.__ragentWindowsTerminate === 'function') {
          await upstream.__ragentWindowsTerminate(0xC0DE);
        } else {
          upstream?.kill?.('SIGTERM');
        }
      } catch {}
      await waitForUpstreamExit();
      try { upstream?.stdin?.end(); } catch {}
      server?.close();
      // Node's Unix server.close() removes its own socket pathname. Never
      // explicitly unlink it: bind may have failed or another process may
      // have replaced the pathname.
    })();
    return shutdownPromise;
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

if (process.argv.includes('--broker')) runBroker();
