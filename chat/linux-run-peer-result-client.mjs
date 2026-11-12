// Client for the future root-owned per-Run result channel. Callers must use a
// root-configured endpoint and independently apply their completion policy.
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { posix as path } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertLinuxRootControlledDirectory } from './linux-target-key-store.mjs';

const LIMIT = 4 * 1024 * 1024;
function unavailable() { return Object.assign(new Error('Protected Run result channel unavailable'), { code: 'LINUX_RUN_RESULT_CHANNEL_UNAVAILABLE' }); }
function absolute(value) {
  return typeof value === 'string' && value.startsWith('/') && value !== '/' && !value.endsWith('/') &&
    path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value);
}
async function verifyExecutable(filename) {
  if (!absolute(filename)) throw unavailable();
  await assertLinuxRootControlledDirectory(path.dirname(filename));
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 ||
      (info.mode & 0o022) || !(info.mode & 0o111)) throw unavailable();
}
async function serverPeer(socket, helper) {
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw unavailable();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(helper, [], { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore', fd] });
    let text = '', complete = false;
    const finish = (error, value) => { if (complete) return; complete = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(unavailable()); }, 2000);
    child.stdout.on('data', chunk => { text += chunk.toString('utf8'); if (Buffer.byteLength(text) > 1024) { child.kill('SIGKILL'); finish(unavailable()); } });
    child.once('error', () => finish(unavailable()));
    child.once('close', (code, signal) => code === 0 && !signal ? finish(null, text) : finish(unavailable()));
  });
  const peer = JSON.parse(output);
  if (!peer || Object.keys(peer).sort().join(',') !== 'gid,pid,uid' || peer.uid !== 0 || peer.gid !== 0 ||
      !Number.isSafeInteger(peer.pid) || peer.pid <= 1) throw unavailable();
}

async function requestProtectedResult(request, { socketPath, peerHelper = '/usr/lib/agentoc/privileged-peercred', timeoutMs = 15000 } = {}) {
  if (process.platform !== 'linux' || !absolute(socketPath) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000 ||
      typeof request.runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(request.runId) ||
      !Number.isSafeInteger(request.launchAttempt) || request.launchAttempt < 0 || request.launchAttempt > 10000) throw unavailable();
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded) > LIMIT) throw unavailable();
  try {
    await assertLinuxRootControlledDirectory(path.dirname(socketPath));
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022) !== 0o022) throw unavailable();
    await verifyExecutable(peerHelper);
    return await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let done = false, authenticated = false, total = 0;
      const chunks = [];
      const timer = setTimeout(() => finish(unavailable()), timeoutMs);
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.on('error', () => finish(unavailable()));
      socket.on('end', () => finish(unavailable()));
      socket.on('data', chunk => {
        if (!authenticated) return finish(unavailable());
        total += chunk.length;
        if (total > LIMIT + 4096) return finish(unavailable());
        chunks.push(chunk);
        const newline = chunk.indexOf(10);
        if (newline < 0) return;
        if (newline !== chunk.length - 1) return finish(unavailable());
        try {
          const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total).subarray(0, total - 1)));
          if (!response || Object.keys(response).sort().join(',') !== 'ok,value' || response.ok !== true) throw unavailable();
          finish(null, response.value);
        } catch { finish(unavailable()); }
      });
      socket.once('connect', () => {
        void serverPeer(socket, peerHelper).then(() => { if (!done) { authenticated = true; socket.write(encoded); } }, () => finish(unavailable()));
      });
    });
  } catch { throw unavailable(); }
}

export async function stageProtectedLinuxRunResult({ runId, launchAttempt, result, ...options } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable();
  const value = await requestProtectedResult({ type: 'stage', runId, launchAttempt, result }, options);
  if (!value || Object.keys(value).sort().join(',') !== 'duplicate,staged' || value.staged !== true ||
      typeof value.duplicate !== 'boolean') throw unavailable();
  return value;
}

// Registration follows systemd accepting the unit. Wait before invoking any
// provider so short Runs cannot finish before root has bound their identity.
export async function waitForProtectedLinuxRunReady({ runId, launchAttempt, maxWaitMs = 15000, ...options } = {}) {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 100 || maxWaitMs > 60000) throw unavailable();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining < 100) break;
    try {
      const value = await requestProtectedResult({ type: 'ready', runId, launchAttempt },
        { ...options, timeoutMs: Math.min(2000, remaining) });
      if (!value || Object.keys(value).join(',') !== 'ready' || value.ready !== true) throw unavailable();
      return;
    } catch {
      const delay = Math.min(100, deadline - Date.now());
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw unavailable();
}

export async function readProtectedLinuxRunResult({ runId, launchAttempt, ...options } = {}) {
  const value = await requestProtectedResult({ type: 'read', runId, launchAttempt }, options);
  if (value === null) return null;
  if (!value || Object.keys(value).sort().join(',') !== 'invocationId,launchAttempt,result,runId,sessionId,turnId,version' ||
      value.version !== 1 || value.runId !== runId || value.launchAttempt !== launchAttempt ||
      typeof value.sessionId !== 'string' || !value.sessionId || typeof value.turnId !== 'string' || !value.turnId ||
      typeof value.invocationId !== 'string' || !/^[a-f0-9]{32}$/.test(value.invocationId) ||
      !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) throw unavailable();
  return value;
}

export async function discardProtectedLinuxRunResult({ runId, launchAttempt, ...options } = {}) {
  const value = await requestProtectedResult({ type: 'discard', runId, launchAttempt }, options);
  if (!value || Object.keys(value).join(',') !== 'discarded' || value.discarded !== true) throw unavailable();
  return value;
}

// Only the configured control UID can ask the root broker for this evidence.
// Revocation alone does not imply that the runner and its descendants stopped.
export async function confirmProtectedLinuxRunStopped({ runId, launchAttempt, ...options } = {}) {
  const value = await requestProtectedResult({ type: 'stopped', runId, launchAttempt }, options);
  if (!value || Object.keys(value).join(',') !== 'stopped' || value.stopped !== true) throw unavailable();
  return true;
}
