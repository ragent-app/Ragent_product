// Optional root-only Unix socket service for the protected Run result store.
// It is deliberately not started by product units until the dynamic-user
// lifecycle, cancellation and control-plane adoption paths are integrated.
import { spawn } from 'node:child_process';
import { chmod, lstat, statfs, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { posix as path } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';
import { stageLinuxRunPeerResult, readRevokedLinuxRunPeerResult, discardRevokedLinuxRunPeerResult } from './linux-run-peer-result-store.mjs';
import { loadLinuxServiceKeyPin } from './linux-service-key-pin.mjs';
import { confirmRevokedLinuxRunStopped, withLinuxRunPeerContext } from './linux-run-context-store.mjs';

const MAX_REQUEST = 4 * 1024 * 1024;
const MAX_CLIENTS = 32;
const REQUEST_DEADLINE_MS = 15000;
function fail() { throw new Error('Protected result server unavailable'); }
function validAbsolute(filename) {
  return typeof filename === 'string' && filename.startsWith('/') && filename !== '/' &&
    !filename.endsWith('/') && path.normalize(filename) === filename && !/[\x00-\x1f\x7f]/.test(filename);
}
async function assertPeerHelper(helper) {
  if (!validAbsolute(helper)) fail();
  await assertLinuxRootControlledDirectory(path.dirname(helper));
  const info = await lstat(helper);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 ||
      (info.mode & 0o022) || !(info.mode & 0o100)) fail();
}
async function peerCredentials(socket, helper) {
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) fail();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(helper, [], { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore', fd] });
    let data = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Peer credential timeout')); }, 2000);
    child.stdout.on('data', chunk => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > 1024) { child.kill('SIGKILL'); finish(new Error('Peer credential output too large')); }
    });
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => code === 0 && !signal ? finish(null, data) : finish(new Error('Peer credential check failed')));
  });
  const peer = JSON.parse(output);
  if (!peer || Object.keys(peer).sort().join(',') !== 'gid,pid,uid' ||
      !Number.isSafeInteger(peer.pid) || peer.pid <= 1 || !Number.isSafeInteger(peer.uid) || peer.uid < 0 ||
      !Number.isSafeInteger(peer.gid) || peer.gid < 0) fail();
  return peer;
}
function decodeRequest(buffer) {
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(request.runId) ||
      !Number.isSafeInteger(request.launchAttempt) || request.launchAttempt < 0 || request.launchAttempt > 10000) fail();
  const keys = Object.keys(request).sort().join(',');
  if ((request.type === 'stage' && keys === 'launchAttempt,result,runId,type') ||
      (['ready', 'read', 'discard', 'stopped'].includes(request.type) && keys === 'launchAttempt,runId,type')) return request;
  fail();
}

export async function createLinuxRunPeerResultServer({ socketPath, directory, pinDirectory, resultDirectory,
  controlUid, peerHelper = '/usr/lib/agentoc/privileged-peercred', inheritFd = null } = {}) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !validAbsolute(socketPath) ||
      !Number.isSafeInteger(controlUid) || controlUid <= 0 || controlUid > 0xfffffffe ||
      (inheritFd !== null && (!Number.isSafeInteger(inheritFd) || inheritFd < 3))) fail();
  await assertLinuxRootControlledDirectory(path.dirname(socketPath));
  for (const folder of [directory, resultDirectory]) {
    if (!validAbsolute(folder)) fail();
    await assertLinuxRootControlledDirectory(folder);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 ||
        (info.mode & 0o7777) !== 0o700 || (await statfs(folder, { bigint: true })).type !== 0xef53n) fail();
  }
  await loadLinuxServiceKeyPin(pinDirectory);
  await assertPeerHelper(peerHelper);
  // An inherited endpoint is owned by systemd. Otherwise never unlink an
  // existing path: it could be another active instance.
  if (inheritFd === null) {
    try { await lstat(socketPath); fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o666) fail();
  }
  const sockets = new Set(), pending = new Set();
  let closing = false;
  const server = createServer(socket => {
    if (closing || sockets.size >= MAX_CLIENTS) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const timer = setTimeout(() => socket.destroy(), REQUEST_DEADLINE_MS);
    socket.once('close', () => clearTimeout(timer));
    let total = 0, handled = false;
    const chunks = [];
    socket.on('data', chunk => {
      if (handled) return;
      total += chunk.length;
      if (total > MAX_REQUEST) { handled = true; socket.destroy(); return; }
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      handled = true;
      if (newline !== chunk.length - 1) { socket.destroy(); return; }
      socket.pause();
      const task = (async () => {
        const request = decodeRequest(Buffer.concat(chunks, total).subarray(0, total - 1));
        const peer = await peerCredentials(socket, peerHelper);
        let value;
        if (request.type === 'ready') {
          value = await withLinuxRunPeerContext({ directory, pinDirectory, runId: request.runId,
            launchAttempt: request.launchAttempt, peer }, async () => ({ ready: true }));
        } else if (request.type === 'stage') {
          value = await stageLinuxRunPeerResult({ directory, pinDirectory, resultDirectory,
            runId: request.runId, launchAttempt: request.launchAttempt, peer, result: request.result });
        } else {
          if (peer.uid !== controlUid) fail();
          if (request.type === 'stopped') {
            value = await confirmRevokedLinuxRunStopped({ directory,
              runId: request.runId, launchAttempt: request.launchAttempt });
          } else {
            const operation = request.type === 'discard' ? discardRevokedLinuxRunPeerResult : readRevokedLinuxRunPeerResult;
            value = await operation({ directory, resultDirectory,
              runId: request.runId, launchAttempt: request.launchAttempt });
          }
        }
        if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, value })}\n`);
      })().catch(() => { if (!socket.destroyed) socket.end('{"ok":false}\n'); });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
  });
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(inheritFd === null ? socketPath : { fd: inheritFd }, () => { server.off('error', onError); resolve(); });
  });
  // Connection-level failures are returned to clients; prevent a later server
  // error from terminating the host process unexpectedly.
  server.on('error', () => {});
  let identity;
  try {
    identity = await lstat(socketPath);
    if (!identity.isSocket() || identity.uid !== 0 || identity.gid !== 0) fail();
    if (inheritFd === null) await chmod(socketPath, 0o666);
    const current = await lstat(socketPath);
    if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino ||
        current.uid !== 0 || current.gid !== 0 || (current.mode & 0o7777) !== 0o666) fail();
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    const current = await lstat(socketPath).catch(() => null);
    if (inheritFd === null && identity && current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) await unlink(socketPath);
    throw error;
  }
  return {
    socketPath,
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
      const current = await lstat(socketPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (inheritFd === null && current && current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) await unlink(socketPath);
    },
  };
}
