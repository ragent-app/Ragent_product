import { createInterface } from 'readline';
import { connect } from 'net';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import {
  buildToolProcessEnvOverrides,
  getToolDefinitionAsync,
  resolveToolCommandPathAsync,
} from '../lib/tools.mjs';
import { applyManagedRuntimeEnv } from './runtime-policy.mjs';
import { buildPlatformSpawnSpec } from '../lib/executable-resolution.mjs';
import { spawnManagedProviderProcess, terminateProviderProcessTree } from '../lib/windows-managed-spawn.mjs';
import { buildCodexAppServerProjectTrustArgs } from './adapters/codex-app-server.mjs';
import {
  buildCodexAppServerInitializeMessage,
  buildCodexAppServerInitializedNotification,
  buildCodexAppServerModelListMessage,
  buildCodexAppServerThreadForkMessage,
  isCodexAppServerRagentApprovalGateEnabled,
  readCodexAppServerThreadId,
} from './codex-app-server-protocol.mjs';
import {
  codexAppServerBrokerLockPath,
  codexAppServerBrokerSocketPath,
  codexBrokerAccountDigest,
  ensureCodexAppServerBroker,
} from './codex-app-server-broker.mjs';
import { buildSharedCodexWindowsHook } from './codex-shared-windows-hook.mjs';
import { WORKBENCH_EXECUTION_POLICY } from '../lib/workbench-execution-policy.mjs';
import { CONFIG_DIR, CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { dirname } from 'node:path';

const CODEX_APP_SERVER_REQUEST_IDS = Object.freeze({
  fork: 10,
});

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL_LIST_PAGE_SIZE = 100;
const MAX_MODEL_LIST_PAGES = 50;
const MAX_MODEL_LIST_ENTRIES = 5_000;
const STDERR_PREVIEW_CHARS = 1200;
const MAX_APP_SERVER_JSON_LINE_BYTES = 8 * 1024 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipPreview(value, maxChars = STDERR_PREVIEW_CHARS) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function readErrorMessage(error) {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'unknown app-server error';
  } catch {
    return 'unknown app-server error';
  }
}

function writeJsonLine(proc, message) {
  if (!message || !proc?.stdin?.writable) return false;
  try {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexToolInvocation(toolId = 'codex', { codexHomeDir = '' } = {}) {
  const tool = await getToolDefinitionAsync(toolId);
  const command = trimString(tool?.command) || 'codex';
  const resolvedCommand = await resolveToolCommandPathAsync(command);
  if (!resolvedCommand) throw Object.assign(new Error('Internal Codex is not installed. Install it in Ragent Harness management.'), { code: 'HARNESS_RUNTIME_UNAVAILABLE' });
  const envOverrides = buildToolProcessEnvOverrides(tool || { id: toolId });
  const env = await applyManagedRuntimeEnv(
    toolId,
    buildToolProcessEnv(envOverrides),
    { runtimeFamily: 'codex-app-server-json' },
  );
  return {
    command: resolvedCommand,
    env: {
      ...env,
      ...(trimString(codexHomeDir) ? { CODEX_HOME: trimString(codexHomeDir) } : {}),
    },
  };
}

function normalizeCodexModelListEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = trimString(entry.model || entry.id);
  if (!id) return null;
  const effortLevels = [];
  for (const effort of Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : []) {
    const value = trimString(
      typeof effort === 'string'
        ? effort
        : effort?.reasoningEffort || effort?.reasoning_effort || effort?.id,
    ).toLowerCase();
    if (value && !effortLevels.includes(value)) effortLevels.push(value);
  }
  const defaultEffort = trimString(
    entry.defaultReasoningEffort || entry.default_reasoning_effort,
  ).toLowerCase();
  return {
    id,
    label: trimString(entry.displayName || entry.display_name || entry.name) || id,
    effortLevels,
    ...(effortLevels.includes(defaultEffort) ? { defaultEffort } : {}),
    ...(Array.isArray(entry.inputModalities)
      ? { inputModalities: entry.inputModalities.map((value) => trimString(value)).filter(Boolean) }
      : {}),
    ...(typeof entry.supportsPersonality === 'boolean'
      ? { supportsPersonality: entry.supportsPersonality }
      : {}),
    ...(entry.isDefault === true ? { isDefault: true } : {}),
    ...(entry.hidden === true ? { hidden: true } : {}),
  };
}

async function requestCodexModelListFromBroker(socketPath, {
  timeoutMs = DEFAULT_MODEL_LIST_TIMEOUT_MS,
  pageSize = DEFAULT_MODEL_LIST_PAGE_SIZE,
  includeHidden = false,
  connectImpl = connect,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let nextRequestId = 100;
    let currentPageRequestId = null;
    let pageCount = 0;
    const models = [];
    const modelIds = new Set();
    const seenCursors = new Set();
    const initializeId = buildCodexAppServerInitializeMessage().id;
    const socket = connectImpl(socketPath);

    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    const writeMessage = (message) => {
      if (!message || socket.destroyed || !socket.writable) {
        finish(new Error('Codex app-server broker connection is not writable'));
        return false;
      }
      try {
        socket.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch (error) {
        finish(error);
        return false;
      }
    };

    const requestPage = (cursor = '') => {
      if (pageCount >= MAX_MODEL_LIST_PAGES) {
        finish(new Error(`Codex model/list exceeded ${MAX_MODEL_LIST_PAGES} pages`));
        return;
      }
      pageCount += 1;
      const id = nextRequestId;
      nextRequestId += 1;
      currentPageRequestId = id;
      writeMessage(buildCodexAppServerModelListMessage({
        id,
        cursor,
        limit: pageSize,
        includeHidden,
      }));
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Codex model/list after ${Math.max(1_000, timeoutMs)}ms`));
    }, Math.max(1_000, timeoutMs));
    timer.unref?.();

    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled) finish(new Error('Codex app-server broker closed before model/list completed'));
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_APP_SERVER_JSON_LINE_BYTES) {
          finish(new Error(`Codex app-server response line exceeded ${MAX_APP_SERVER_JSON_LINE_BYTES} bytes`));
          return;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id === initializeId) {
          if (message.error) {
            finish(new Error(readErrorMessage(message.error)));
            return;
          }
          writeMessage(buildCodexAppServerInitializedNotification());
          requestPage();
          continue;
        }
        if (message?.id !== currentPageRequestId) continue;
        currentPageRequestId = null;
        if (message.error) {
          finish(new Error(readErrorMessage(message.error)));
          return;
        }
        if (!message.result || !Array.isArray(message.result.data)) {
          finish(new Error('Codex model/list response did not include a data array'));
          return;
        }
        for (const rawEntry of message.result.data) {
          const entry = normalizeCodexModelListEntry(rawEntry);
          if (!entry || (!includeHidden && entry.hidden) || modelIds.has(entry.id)) continue;
          modelIds.add(entry.id);
          models.push(entry);
          if (models.length > MAX_MODEL_LIST_ENTRIES) {
            finish(new Error(`Codex model/list exceeded ${MAX_MODEL_LIST_ENTRIES} entries`));
            return;
          }
        }
        const nextCursor = trimString(message.result.nextCursor || message.result.next_cursor);
        if (!nextCursor) {
          finish(null, models);
          return;
        }
        if (seenCursors.has(nextCursor)) {
          finish(new Error('Codex model/list returned a repeated cursor'));
          return;
        }
        seenCursors.add(nextCursor);
        requestPage(nextCursor);
      }
      if (!settled && Buffer.byteLength(buffer, 'utf8') > MAX_APP_SERVER_JSON_LINE_BYTES) {
        finish(new Error(`Codex app-server response line exceeded ${MAX_APP_SERVER_JSON_LINE_BYTES} bytes`));
      }
    });
    socket.once('connect', () => {
      writeMessage(buildCodexAppServerInitializeMessage());
    });
  });
}

export async function listCodexAppServerModels({
  toolId = 'codex',
  codexHomeDir,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_MODEL_LIST_TIMEOUT_MS,
  pageSize = DEFAULT_MODEL_LIST_PAGE_SIZE,
  includeHidden = false,
  upstreamFile = '',
  upstreamArgs = null,
  environment = null,
  ensureBrokerImpl = ensureCodexAppServerBroker,
  connectImpl = connect,
} = {}) {
  const home = trimString(codexHomeDir);
  if (!home) throw new Error('Codex home is required for model/list');
  const startedAt = Date.now();
  let command = trimString(upstreamFile);
  let env = environment && typeof environment === 'object'
    ? { ...environment, CODEX_HOME: home }
    : null;
  if (!command) {
    const invocation = await resolveCodexToolInvocation(toolId, { codexHomeDir: home });
    command = invocation.command;
    env = invocation.env;
  }
  const socketPath = codexAppServerBrokerSocketPath(home);
  const args = Array.isArray(upstreamArgs) ? upstreamArgs : [
    'app-server', '--stdio', ...(process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY ? buildSharedCodexWindowsHook({ socketPath }).args : []),
  ];
  const spawnSpec = buildPlatformSpawnSpec(command, args, {
    cwd: trimString(cwd) || process.cwd(),
    env: env || { ...process.env, CODEX_HOME: home },
  });
  await ensureBrokerImpl({
    socketPath,
    lockPath: codexAppServerBrokerLockPath(home),
    upstreamFile: spawnSpec.file,
    upstreamArgs: spawnSpec.args,
    upstreamWindowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
    cwd: trimString(cwd) || process.cwd(),
    env: spawnSpec.env,
    waitMs: Math.max(1_000, timeoutMs),
  });
  const remainingMs = Math.max(1_000, Math.max(1_000, timeoutMs) - (Date.now() - startedAt));
  return requestCodexModelListFromBroker(socketPath, {
    timeoutMs: remainingMs,
    pageSize,
    includeHidden,
    connectImpl,
  });
}

const CODEX_CAPABILITY_METHODS = Object.freeze({
  skills: { method: 'skills/list', params: (cwd) => ({ cwds: [cwd], forceReload: false }) },
  plugins: { method: 'plugin/list', params: (cwd) => ({ cwds: [cwd] }) },
  mcp: { method: 'mcpServerStatus/list', params: () => ({ detail: 'toolsAndAuthOnly' }) },
});

async function requestCodexCapabilityCatalogFromBroker(socketPath, method, params, {
  timeoutMs = 10_000,
  connectImpl = connect,
  expectedAccountId = '',
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const initializeId = 0;
    const requestId = 101;
    const socket = connectImpl(socketPath);
    const expectedDigest = codexBrokerAccountDigest(expectedAccountId);
    let checkingAccount = Boolean(expectedDigest);
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const writeMessage = (message) => {
      if (!message || socket.destroyed || !socket.writable) {
        finish(new Error('Codex app-server broker connection is not writable'));
        return false;
      }
      try {
        socket.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch (error) {
        finish(error);
        return false;
      }
    };
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for Codex ${method}`)), Math.max(1_000, timeoutMs));
    timer.unref?.();
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled) finish(new Error(`Codex app-server broker closed before ${method} completed`));
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_APP_SERVER_JSON_LINE_BYTES) {
          finish(new Error(`Codex app-server response line exceeded ${MAX_APP_SERVER_JSON_LINE_BYTES} bytes`));
          return;
        }
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (checkingAccount) {
          if (message?.type !== 'agentoc-codex-broker-pong' || message.ready !== true || message.accountMatches !== true) {
            finish(new Error('The Codex broker could not verify the selected account'));
            return;
          }
          checkingAccount = false;
          writeMessage(buildCodexAppServerInitializeMessage());
          continue;
        }
        if (message?.id === initializeId) {
          if (message.error) {
            finish(new Error(readErrorMessage(message.error)));
            return;
          }
          writeMessage(buildCodexAppServerInitializedNotification());
          writeMessage({ method, id: requestId, params });
          continue;
        }
        if (message?.id !== requestId) continue;
        if (message.error) {
          finish(new Error(readErrorMessage(message.error)));
          return;
        }
        finish(null, message.result && typeof message.result === 'object' ? message.result : {});
      }
      if (!settled && Buffer.byteLength(buffer, 'utf8') > MAX_APP_SERVER_JSON_LINE_BYTES) {
        finish(new Error(`Codex app-server response line exceeded ${MAX_APP_SERVER_JSON_LINE_BYTES} bytes`));
      }
    });
    socket.once('connect', () => writeMessage(checkingAccount
      ? { type: 'agentoc-codex-broker-ping', expectedAccountDigest: expectedDigest }
      : buildCodexAppServerInitializeMessage()));
  });
}

/** Read the current Codex home’s native skills, plugins and MCP status. */
export async function listCodexAppServerCapabilities({
  toolId = 'codex',
  codexHomeDir,
  cwd = process.cwd(),
  timeoutMs = 12_000,
  upstreamFile = '',
  upstreamArgs = null,
  environment = null,
  ensureBrokerImpl = ensureCodexAppServerBroker,
  connectImpl = connect,
} = {}) {
  const home = trimString(codexHomeDir);
  if (!home) throw new Error('Codex home is required for capability discovery');
  const workingDirectory = trimString(cwd) || process.cwd();
  const startedAt = Date.now();
  let command = trimString(upstreamFile);
  let env = environment && typeof environment === 'object'
    ? { ...environment, CODEX_HOME: home }
    : null;
  if (!command) {
    const invocation = await resolveCodexToolInvocation(toolId, { codexHomeDir: home });
    command = invocation.command;
    env = invocation.env;
  }
  const socketPath = codexAppServerBrokerSocketPath(home);
  const args = Array.isArray(upstreamArgs) ? upstreamArgs : [
    'app-server', '--stdio', ...(process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY ? buildSharedCodexWindowsHook({ socketPath }).args : []),
  ];
  const spawnSpec = buildPlatformSpawnSpec(command, args, { cwd: workingDirectory, env: env || { ...process.env, CODEX_HOME: home } });
  await ensureBrokerImpl({
    socketPath,
    lockPath: codexAppServerBrokerLockPath(home),
    upstreamFile: spawnSpec.file,
    upstreamArgs: spawnSpec.args,
    upstreamWindowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
    cwd: workingDirectory,
    env: spawnSpec.env,
    waitMs: Math.max(1_000, timeoutMs),
  });
  const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
  const entries = Object.entries(CODEX_CAPABILITY_METHODS);
  const results = await Promise.all(entries.map(async ([key, spec]) => {
    try {
      const data = await requestCodexCapabilityCatalogFromBroker(socketPath, spec.method, spec.params(workingDirectory), {
        timeoutMs: remainingMs,
        connectImpl,
      });
      return [key, { ok: true, data }];
    } catch (error) {
      return [key, { ok: false, error: readErrorMessage(error) }];
    }
  }));
  return Object.fromEntries(results);
}

function normalizeForkResult(message) {
  const threadId = readCodexAppServerThreadId(message);
  if (!threadId) return null;
  return {
    threadId,
    response: message,
  };
}

export async function forkCodexThreadViaBroker(socketPath, forkMessage, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, expectedAccountId = '' } = {}) {
  const result = await requestCodexCapabilityCatalogFromBroker(socketPath, 'thread/fork', forkMessage.params, { timeoutMs, expectedAccountId });
  const normalized = normalizeForkResult({ id: CODEX_APP_SERVER_REQUEST_IDS.fork, result });
  if (!normalized) throw new Error('Codex thread/fork response did not include a thread id');
  return normalized;
}

async function runCodexAppServerForkRequest({
  toolId = 'codex',
  cwd,
  threadId,
  model,
  developerInstructions,
  interactionMode,
  permissionMode,
  riskMode,
  providerProfileId,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const sourceThreadId = trimString(threadId);
  if (!sourceThreadId) return null;
  const agentocApprovalGate = isCodexAppServerRagentApprovalGateEnabled({ riskMode, permissionMode });
  let codexHomeDir = '';
  let expectedAccountId = '';
  {
    const { prepareNativeRunProviderHome } = await import('../lib/provider-runtime/run-provider-prepare.mjs');
    const prepared = await prepareNativeRunProviderHome(`fork-${sourceThreadId}`, {
      tool: toolId, runtimeFamily: 'codex-app-server-json', options: { runtimeFamily: 'codex-app-server-json',
        ...(providerProfileId ? { providerProfile: providerProfileId } : {}), ...(model ? { model } : {}) },
    }, { configDir: CONFIG_DIR, providerHomesRoot: dirname(CODEX_MANAGED_HOME_DIR), externalOAuthOwnership: false, holdNativeOAuthLock: false });
    if (prepared?.ok && prepared.codexHomeDir) {
      codexHomeDir = prepared.codexHomeDir;
      expectedAccountId = trimString(prepared.oauthAccountId);
    }
    else if (toolId === 'codex' || toolId === 'codex-cli' || providerProfileId) throw new Error(prepared?.error || prepared?.reason || 'Codex provider home is unavailable');
  }
  const { command, env } = await resolveCodexToolInvocation(toolId, { codexHomeDir });
  const forkMessage = buildCodexAppServerThreadForkMessage({
    id: CODEX_APP_SERVER_REQUEST_IDS.fork,
    threadId: sourceThreadId,
    cwd,
    model,
    developerInstructions,
    interactionMode,
    permissionMode,
    agentocApprovalGate,
  });
  if (!forkMessage) return null;

  if (codexHomeDir) {
    const socketPath = codexAppServerBrokerSocketPath(codexHomeDir);
    const args = ['app-server', '--stdio', ...(process.platform === 'win32' && !WORKBENCH_EXECUTION_POLICY
      ? buildSharedCodexWindowsHook({ socketPath }).args : [])];
    const spawnSpec = buildPlatformSpawnSpec(command, args, { cwd: trimString(cwd) || process.cwd(), env });
    await ensureCodexAppServerBroker({ socketPath, lockPath: codexAppServerBrokerLockPath(codexHomeDir),
      upstreamFile: spawnSpec.file, upstreamArgs: spawnSpec.args,
      upstreamWindowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
      cwd: trimString(cwd) || process.cwd(), env, waitMs: timeoutMs });
    return forkCodexThreadViaBroker(socketPath, forkMessage, { timeoutMs, expectedAccountId });
  }

  const args = ['app-server', '--stdio', ...(agentocApprovalGate ? buildCodexAppServerProjectTrustArgs(cwd) : [])];
  const spawnSpec = buildPlatformSpawnSpec(command, args, {
    cwd: trimString(cwd) || process.cwd(),
    env,
  });
  const proc = await spawnManagedProviderProcess(spawnSpec, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin?.on?.('error', () => {});

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let reader = null;

    const cleanup = () => {
      clearTimeout(timer);
      try { reader?.close?.(); } catch {}
      try {
        if (proc.stdin.writable) proc.stdin.end();
      } catch {}
      terminateProviderProcessTree(proc, 'SIGTERM');
      const killTimer = setTimeout(() => {
        if (proc.exitCode !== null) return;
        terminateProviderProcessTree(proc, 'SIGKILL');
      }, 2000);
      killTimer.unref?.();
    };

    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Codex thread/fork response${stderr ? `: ${clipPreview(stderr)}` : ''}`));
    }, Math.max(1000, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();

    proc.on('error', (error) => {
      finish(error);
    });
    proc.on('exit', (code, signal) => {
      if (settled) return;
      finish(new Error(`Codex app-server exited before thread/fork response: code=${code ?? 'null'} signal=${signal || 'null'}${stderr ? ` stderr=${clipPreview(stderr)}` : ''}`));
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > STDERR_PREVIEW_CHARS * 2) {
        stderr = stderr.slice(-STDERR_PREVIEW_CHARS * 2);
      }
    });

    reader = createInterface({ input: proc.stdout });
    reader.on('error', (error) => finish(error));
    reader.on('line', (line) => {
      if (settled) return;
      if (Buffer.byteLength(line, 'utf8') > MAX_APP_SERVER_JSON_LINE_BYTES) {
        finish(new Error(`Codex app-server response line exceeded ${MAX_APP_SERVER_JSON_LINE_BYTES} bytes`));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.id !== CODEX_APP_SERVER_REQUEST_IDS.fork) return;
      if (message.error) {
        finish(new Error(readErrorMessage(message.error)));
        return;
      }
      const result = normalizeForkResult(message);
      if (!result) {
        finish(new Error('Codex thread/fork response did not include a thread id'));
        return;
      }
      finish(null, result);
    });

    try {
      writeJsonLine(proc, buildCodexAppServerInitializeMessage());
      writeJsonLine(proc, buildCodexAppServerInitializedNotification());
      writeJsonLine(proc, forkMessage);
    } catch (error) {
      finish(error);
    }
  });
}

export async function forkCodexAppServerThread(options = {}) {
  return runCodexAppServerForkRequest(options);
}
