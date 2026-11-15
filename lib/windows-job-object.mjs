import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { win32 } from 'path';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_WRAPPER = join(ROOT, 'scripts', 'windows-job-object-host.cmd');
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

export function resolveWindowsJobHostPaths(env = process.env) {
  const paths = resolveWindowsSystemPaths(env);
  if (!paths) return null;
  return { cmd: win32.join(paths.system32, 'cmd.exe'), root: paths.root };
}

function normalizeError(error, fallback = 'Windows Job Object request failed') {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' && error ? error : fallback);
}

function encodeChunk(chunk) {
  return Buffer.from(chunk).toString('base64');
}

function decodeChunk(value) {
  return Buffer.from(String(value || ''), 'base64');
}

export function normalizeWindowsEnvironment(env) {
  if (!env || typeof env !== 'object') return undefined;
  const normalized = {};
  let pathValue;
  for (const [rawKey, rawValue] of Object.entries(env)) {
    const key = String(rawKey);
    if (!key || key.includes('\0')) throw new Error('Windows managed process environment contains an invalid key');
    if (rawValue === undefined || rawValue === null) continue;
    if (key.toLowerCase() === 'path') {
      if (key === 'PATH' || pathValue === undefined) pathValue = rawValue;
      continue;
    }
    const value = String(rawValue);
    if (value.includes('\0')) throw new Error(`Windows managed process environment contains NUL in ${key}`);
    normalized[key] = value;
  }
  if (pathValue !== undefined) {
    const value = String(pathValue);
    if (value.includes('\0')) throw new Error('Windows managed process environment contains NUL in PATH');
    normalized.PATH = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function createManagedStdin(job) {
  return new Writable({
    write(chunk, encoding, callback) {
      job.command({ type: 'stdin', data: encodeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)) })
        .then(() => callback(), callback);
    },
    final(callback) {
      job.command({ type: 'stdin-close' }).then(() => callback(), callback);
    },
  });
}

function createManagedProcess(job, response) {
  const proc = new EventEmitter();
  proc.pid = Number(response.pid);
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.exitEmitted = false;
  proc.stdin = createManagedStdin(job);
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.__ragentWindowsTerminate = (code = 0xC0DE) => job.terminate(code);
  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    void proc.__ragentWindowsTerminate(signal === 'SIGKILL' ? 0xC0DE : 0xC0DE).catch(() => {});
    return true;
  };
  proc.emitExit = (code, signal) => {
    if (proc.exitEmitted) return;
    proc.exitEmitted = true;
    proc.exitCode = Number.isFinite(Number(code)) ? Number(code) : 1;
    proc.signalCode = signal || null;
    proc.stdout.end();
    proc.stderr.end();
    if (!proc.stdin.destroyed) proc.stdin.destroy();
    proc.emit('exit', proc.exitCode, proc.signalCode);
    proc.emit('close', proc.exitCode, proc.signalCode);
  };
  job.process = proc;
  return proc;
}

export function isWindowsJobObjectSupported(platform = process.platform) {
  return platform === 'win32';
}

export async function createWindowsJobObject({
  spawnImpl = spawn,
  preserveOnControllerExit = false,
} = {}) {
  if (!isWindowsJobObjectSupported()) return null;
  const system = resolveWindowsJobHostPaths();
  if (!system) throw new Error('Windows system directory is unavailable for Job Object host');
  const pipeName = `ragent-job-${process.pid}-${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`;
  const pipePath = `${WINDOWS_PIPE_PREFIX}${pipeName}`;
  const pipeServer = createServer();
  let socket = null;
  let reader = null;
  let host = null;
  const hostArgs = [
    '/d', '/s', '/c', 'call', HOST_WRAPPER, '-PipeName', pipeName,
    ...(preserveOnControllerExit === true ? ['-PreserveOnControllerExit'] : []),
  ];

  const pending = new Map();
  let nextRequestId = 1;
  let readyResolve;
  let readyReject;
  let hostFailure = null;
  let readyTimer;
  let hostPreserveOnControllerExit = null;
  let transportClosing = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const failHost = (error) => {
    if (hostFailure) return;
    const normalized = normalizeError(error, 'Windows Job Object host exited');
    hostFailure = normalized;
    clearTimeout(readyTimer);
    readyReject?.(normalized);
    for (const entry of pending.values()) entry.reject(normalized);
    pending.clear();
    try {
      if (host?.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.unref?.();
      } else {
        host?.kill?.();
      }
    } catch {}
    try { socket?.destroy(); } catch {}
    try { pipeServer.close(); } catch {}
  };

  const handleLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failHost(new Error(`Invalid Windows Job Object response: ${line}`));
      return;
    }
    if (message.ready === true) {
      hostPreserveOnControllerExit = message.preserveOnControllerExit === true;
      clearTimeout(readyTimer);
      readyResolve(message);
      return;
    }
    if (message.event) {
      const proc = job.process;
      if (!proc) return;
      if (message.event === 'stdout') proc.stdout.write(decodeChunk(message.data));
      else if (message.event === 'stderr') proc.stderr.write(decodeChunk(message.data));
      else if (message.event === 'exit') {
        setImmediate(() => proc.emitExit(message.code, message.signal));
      }
      return;
    }
    const requestId = Number(message.id);
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    if (!message.ok) entry.reject(new Error(message.error || 'Windows Job Object request failed'));
    else entry.resolve(message);
  };

  pipeServer.on('connection', (incoming) => {
    if (socket) {
      incoming.destroy();
      return;
    }
    socket = incoming;
    reader = createInterface({ input: socket });
    reader.on('line', handleLine);
    socket.once('error', (error) => {
      if (!hostFailure) failHost(error);
    });
    socket.once('close', () => {
      if (!hostFailure && !transportClosing && host?.exitCode === null) {
        failHost(new Error('Windows Job Object host control pipe closed'));
      }
    });
    pipeServer.close();
  });
  pipeServer.on('error', failHost);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      pipeServer.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      pipeServer.removeListener('error', onError);
      resolve();
    };
    pipeServer.once('error', onError);
    pipeServer.once('listening', onListening);
    pipeServer.listen(pipePath);
  });

  try {
    host = spawnImpl(system.cmd, hostArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
      env: { ...process.env, SystemRoot: system.root, WINDIR: system.root },
      // The detached cmd wrapper is a fixed runtime helper. The user/provider
      // command never passes through this shell; it is sent only to the host's
      // explicit CreateProcessW operation over the named pipe.
      windowsVerbatimArguments: false,
    });
  } catch (error) {
    failHost(error);
    throw error;
  }
  host.stdout?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.error(`[windows-job-host] ${text}`);
  });
  host.stderr?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.error(`[windows-job-host] ${text}`);
  });
  host.once('error', failHost);
  host.once('exit', (code, signal) => {
    if (!hostFailure && code !== 0) {
      failHost(new Error(`Windows Job Object host exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`));
    }
  });
  readyTimer = setTimeout(() => {
    failHost(new Error('Windows Job Object host ready handshake timed out'));
  }, 10_000);

  const job = {
    host,
    process: null,
    get hostPreserveOnControllerExit() { return hostPreserveOnControllerExit; },
    command(payload) {
      if (hostFailure) return Promise.reject(hostFailure);
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          if (!socket || socket.destroyed) throw new Error('Windows Job Object host control pipe is not connected');
          socket.write(`${JSON.stringify({ ...payload, id })}\n`);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    async createProcess({ file, args = [], cwd, env, windowsVerbatimArguments = false, stdin = true, stdout = true, stderr = true } = {}) {
      await ready;
      const response = await this.command({
        type: 'create',
        file,
        args,
        cwd,
        env: normalizeWindowsEnvironment(env),
        windowsVerbatimArguments: windowsVerbatimArguments === true,
        stdio: { stdin: stdin === true, stdout: stdout === true, stderr: stderr === true },
      });
      const process = createManagedProcess(this, response);
      await this.command({ type: 'start-readers' });
      return process;
    },
    async assign(pid) {
      await ready;
      return this.command({ type: 'assign', pid });
    },
    async list() {
      await ready;
      return this.command({ type: 'list' });
    },
    async terminate(code = 0xC0DE) {
      await ready;
      return this.command({ type: 'terminate', code });
    },
    async close() {
      transportClosing = true;
      try {
        await ready;
        return await this.command({ type: 'close' });
      } catch {
        return null;
      } finally {
        reader?.close();
        try { socket?.end(); } catch {}
        try { pipeServer.close(); } catch {}
      }
    },
  };

  await ready;
  return job;
}
