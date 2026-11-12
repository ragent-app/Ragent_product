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
import { buildWorkbenchCodexEnvironment, constrainCodexBrokerRequest } from '../lib/workbench-execution-policy.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, unlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';
import { spawnManagedProviderProcess } from '../lib/windows-managed-spawn.mjs';
import { buildSharedCodexProcessEnvironment } from './codex-shared-environment.mjs';
import { createCodexWindowsHookRouter } from './codex-windows-hook-router.mjs';
import { MAC_CLEANUP_NOTIFICATION, MAC_CLEANUP_SPOOL_TYPE } from './macos-codex-cancellation.mjs';

const BROKER_PING = 'agentoc-codex-broker-ping';
const BROKER_PONG = 'agentoc-codex-broker-pong';
const BROKER_READY_TIMEOUT_MS = 30_000;
const BROKER_LOCK_WAIT_MS = 15_000;
const BROKER_INTERNAL_INITIALIZE_ID = -1;

export function codexBrokerAccountDigest(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id ? createHash('sha256').update(`agentoc-codex-account:${id}`).digest('hex') : '';
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
  const value = message?.params?.config?.shell_environment_policy?.set?.AGENTOC_RUN_ID;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : '';
}

export function cleanupMacCodexRun(rootPid, runTag, {
  platform = process.platform,
  executable = join(dirname(process.execPath), 'agentoc-macos-run-cleanup'),
  run = spawnSync,
} = {}) {
  if (platform !== 'darwin' || !Number.isSafeInteger(rootPid) || rootPid <= 1 ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(runTag)) return false;
  const result = run(executable, [String(rootPid), runTag], { stdio: 'ignore', timeout: 5000 });
  return !result.error && result.status === 0;
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
    return `\\\\.\\pipe\\agentoc-codex-${digest}`;
  }
  const providerLocalPath = join(home, '.agentoc-codex-app-server.sock');
  // Linux sockaddr_un paths are capped at 108 bytes (macOS is lower). Native
  // provider homes include a hashed by-provider segment and can exceed that
  // limit under long config/test roots. Only shorten paths that cannot have a
  // working legacy broker, so live short-path brokers keep their identity.
  if (Buffer.byteLength(providerLocalPath, 'utf8') <= 100) return providerLocalPath;
  const userId = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const temporaryPath = join(tmpdir(), `agentoc-codex-${userId}-${digest}.sock`);
  return Buffer.byteLength(temporaryPath, 'utf8') <= 100
    ? temporaryPath
    : join('/tmp', `agentoc-codex-${userId}-${digest}.sock`);
}

export function codexAppServerBrokerSocketPath(codexHomeDir) {
  return buildCodexAppServerBrokerSocketPath(codexHomeDir);
}

export function codexAppServerBrokerLockPath(codexHomeDir) {
  const home = trimString(codexHomeDir);
  return home ? join(home, '.agentoc-codex-app-server.lock') : '';
}

function brokerLockPath(socketPath, explicitLockPath = '') {
  const explicit = normalizeSocketPath(explicitLockPath);
  if (explicit) return explicit;
  if (isWindowsNamedPipePath(socketPath)) {
    const digest = createHash('sha256').update(socketPath).digest('hex').slice(0, 32);
    return join(tmpdir(), `agentoc-codex-broker-${digest}.lock`);
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

async function probeBroker(socketPath, timeoutMs = 1_500) {
  const normalized = normalizeSocketPath(socketPath);
  if (!normalized) return false;
  return new Promise((resolve) => {
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
    const timer = setTimeout(() => finish(false), Math.max(100, timeoutMs));
    timer.unref?.();
    socket.on('error', () => finish(false));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message?.type === BROKER_PONG && message.ready === true) finish(true);
        } catch {}
      }
    });
    socket.once('connect', () => writeLine(socket, { type: BROKER_PING }));
  });
}

export async function isCodexAppServerBrokerReady(socketPath, timeoutMs = 1_500) {
  return probeBroker(socketPath, timeoutMs);
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

async function waitForBroker(socketPath, timeoutMs = BROKER_READY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    if (await probeBroker(socketPath, 1_500)) return true;
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
} = {}) {
  const normalizedSocket = normalizeSocketPath(socketPath);
  const file = trimString(upstreamFile);
  if (!normalizedSocket || !file || !Array.isArray(upstreamArgs)) {
    const error = new Error('Codex app-server broker launch specification is incomplete');
    error.code = 'CODEX_APP_SERVER_BROKER_INVALID';
    throw error;
  }
  if (await probeBroker(normalizedSocket)) return { ok: true, socketPath: normalizedSocket, reused: true, pid: null };

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
    if (await probeBroker(normalizedSocket)) {
      return { ok: true, socketPath: normalizedSocket, reused: true, pid: null };
    }
    // A refused connection means the previous broker is gone. Only remove the
    // exact provider-scoped socket path; never use a broad glob or directory.
    await unlink(normalizedSocket).catch(() => {});
    const childEnv = {
      ...toSpawnEnvironment(env),
      AGENTOC_CODEX_BROKER_SOCKET: normalizedSocket,
      AGENTOC_CODEX_BROKER_UPSTREAM_FILE: file,
      AGENTOC_CODEX_BROKER_UPSTREAM_ARGS: JSON.stringify(upstreamArgs),
      AGENTOC_CODEX_BROKER_UPSTREAM_WINDOWS_VERBATIM: upstreamWindowsVerbatimArguments === true ? '1' : '0',
      AGENTOC_CODEX_BROKER_UPSTREAM_CWD: trimString(cwd) || process.cwd(),
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
    // Keep creation serialized through initialize. A second caller otherwise
    // sees an unready socket, unlinks it, and starts a second refresh owner.
    if (!(await waitForBroker(normalizedSocket, waitMs))) {
      try { brokerChild?.kill?.('SIGTERM'); } catch {}
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
      clientInfo: { name: 'agentoc-codex-broker', title: 'AgentoC Codex broker', version: '1' },
      capabilities: { experimentalApi: true },
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
  const socketPath = normalizeSocketPath(process.env.AGENTOC_CODEX_BROKER_SOCKET || readArg('--socket'));
  const upstreamFile = trimString(process.env.AGENTOC_CODEX_BROKER_UPSTREAM_FILE);
  const upstreamCwd = trimString(process.env.AGENTOC_CODEX_BROKER_UPSTREAM_CWD) || process.cwd();
  const upstreamWindowsVerbatimArguments = process.env.AGENTOC_CODEX_BROKER_UPSTREAM_WINDOWS_VERBATIM === '1';
  let upstreamArgs = [];
  try {
    upstreamArgs = JSON.parse(process.env.AGENTOC_CODEX_BROKER_UPSTREAM_ARGS || '[]');
  } catch {}
  if (!socketPath || !upstreamFile || !Array.isArray(upstreamArgs)) {
    console.error('[codex-broker] invalid broker environment');
    process.exitCode = 1;
    return;
  }

  const clients = new Set();
  const threadOwners = new Map();
  const pending = new Map();
  // Server-initiated requests use a separate id namespace from client
  // requests. Keep the original upstream id for the eventual response.
  const pendingServerRequests = new Map();
  const pendingThreadClients = [];
  const threadStartQueue = [];
  const pendingThreadReloads = new Map();
  const hookRouters = new Map();
  const pendingHookCalls = new Map();
  const clientRunTags = new WeakMap();
  let activeThreadRequestId = null;
  let nextRequestId = 10_000;
  let upstreamReady = false;
  let upstream = null;
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
    const threadId = readThreadId(message);
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
      pending.set(entry.id, { client: entry.client, clientId: entry.clientId });
      pendingThreadClients.push(entry.client);
      try { upstream.stdin.write(`${JSON.stringify(entry.message)}\n`); } catch {}
      return;
    }
  };

  const handleUpstreamMessage = (message) => {
    if (!message || typeof message !== 'object') return;
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
      pending.set(entry.id, { client: entry.client, clientId: entry.clientId });
      pendingThreadClients.push(entry.client);
      try { upstream.stdin.write(`${JSON.stringify(entry.message)}\n`); } catch {}
      return;
    }
    if (serverRequest) {
      if (message.method === 'agentoc/windowsHook' || message.method === 'agentoc/registerWindowsHook') {
        try { upstream?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Reserved broker method' } })}\n`); } catch {}
        return;
      }
      const client = threadOwners.get(readThreadId(message));
      if (!client || client.destroyed) {
        try { upstream?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'No connected owner for this thread' } })}\n`); } catch {}
        return;
      }
      const clientRequestId = `agentoc-server-${nextRequestId++}`;
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
      const threadId = readResultThreadId(message);
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
        basePath: process.env.AGENTOC_CODEX_BROKER_BASE_PATH || '',
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
      for (const client of clients) client.end();
      server?.close();
      void oauthLock?.release();
    });
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
    if (message.type === BROKER_PING) {
      sendClient(client, { type: BROKER_PONG, ready: upstreamReady,
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
    if (message.method === 'agentoc/registerWindowsHook' && isRequest(message)) {
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
    if (message.type === 'agentoc-codex-windows-hook') {
      const event = message.event;
      const deny = () => sendClient(client, { error: 'No matching active managed hook' });
      const tryClaim = (remaining) => {
        if (client.destroyed) return;
        const owner = threadOwners.get(event?.session_id);
        const matched = owner && hookRouters.get(owner)?.claim(event);
        if (!matched) {
          if (remaining > 0) { const timer = setTimeout(() => tryClaim(remaining - 1), 50); timer.unref?.(); }
          else deny();
          return;
        }
        const id = `agentoc-hook-${nextRequestId++}`;
        const timer = setTimeout(() => { pendingHookCalls.delete(id); deny(); }, 60_000);
        timer.unref?.();
        pendingHookCalls.set(id, { owner, client, timer });
        if (!sendClient(owner, { id, method: 'agentoc/windowsHook', params: { event } })) {
          clearTimeout(timer); pendingHookCalls.delete(id); deny();
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
        sendClient(hookCall.client, message.error ? { error: 'Hook evaluation failed' } : { result: message.result });
        return;
      }
      const request = pendingServerRequests.get(message.id);
      if (!request || request.client !== client) return;
      pendingServerRequests.delete(message.id);
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
      const cleanupAttempted = Boolean(runTag && cleanupMacCodexRun(upstream?.pid, runTag));
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
      pending.set(upstreamId, { client, clientId: message.id });
      rewritten.id = upstreamId;
    }
    try { upstream.stdin.write(`${JSON.stringify(rewritten)}\n`); } catch {}
  };

  const attachClient = (client) => {
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
      hookRouters.delete(client);
      for (const [id, call] of pendingHookCalls) {
        if (call.client !== client && call.owner !== client) continue;
        clearTimeout(call.timer); pendingHookCalls.delete(id);
        if (call.owner === client) sendClient(call.client, { error: 'Hook owner disconnected' });
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
    await unlink(socketPath).catch(() => {});
    server = createServer(attachClient);
    server.listen(socketPath, async () => {
      await chmod(socketPath, 0o660).catch(() => {});
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
        if (typeof upstream?.__agentocWindowsTerminate === 'function') {
          await upstream.__agentocWindowsTerminate(0xC0DE);
        } else {
          upstream?.kill?.('SIGTERM');
        }
      } catch {}
      await waitForUpstreamExit();
      try { upstream?.stdin?.end(); } catch {}
      server?.close();
      await unlink(socketPath).catch(() => {});
    })();
    return shutdownPromise;
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

if (process.argv.includes('--broker')) runBroker();
