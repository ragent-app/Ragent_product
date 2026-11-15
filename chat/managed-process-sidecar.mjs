#!/usr/bin/env node

import {
  appendManagedProcessOutput,
  loadManagedProcessInternal,
  writeManagedProcessStatus,
} from './managed-processes.mjs';
import {
  buildManagedProcessSpawnSpec,
  spawnManagedProcess,
} from '../lib/windows-managed-spawn.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      return true;
    } catch {
      return false;
    }
  }
  try { process.kill(-pid, 'SIGTERM'); return true; } catch {}
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

function processIdFromArgs(argv) {
  const index = argv.indexOf('--managed-process');
  return index >= 0 ? text(argv[index + 1]) : '';
}

async function run(processId, { watchExisting = false } = {}) {
  const record = await loadManagedProcessInternal(processId);
  if (!record) return 2;
  const { manifest } = record;
  if (watchExisting) {
    const pid = Number(record.status?.pid);
    if (!isPidAlive(pid)) {
      await writeManagedProcessStatus(processId, {
        state: manifest.cancelRequested ? 'cancelled' : 'unknown',
        completedAt: new Date().toISOString(),
        error: manifest.cancelRequested ? manifest.cancelReason || 'cancelled' : 'Recovered watcher found no live process',
        sidecarPid: process.pid,
      });
      return 0;
    }
    await writeManagedProcessStatus(processId, { state: 'running', sidecarPid: process.pid });
    while (isPidAlive(pid)) {
      const latest = await loadManagedProcessInternal(processId);
      if (latest?.manifest?.cancelRequested) {
        await terminatePidTree(pid);
      }
      await sleep(250);
    }
    const latest = await loadManagedProcessInternal(processId);
    await writeManagedProcessStatus(processId, {
      state: latest?.manifest?.cancelRequested ? 'cancelled' : 'unknown',
      completedAt: new Date().toISOString(),
      error: latest?.manifest?.cancelRequested
        ? latest.manifest.cancelReason || 'cancelled'
        : 'Recovered watcher observed process exit without a terminal result',
      sidecarPid: process.pid,
    });
    return 0;
  }
  if (manifest.cancelRequested) {
    await writeManagedProcessStatus(processId, {
      state: 'cancelled',
      completedAt: new Date().toISOString(),
      error: manifest.cancelReason || 'cancelled before start',
      sidecarPid: process.pid,
    });
    return 0;
  }

  await writeManagedProcessStatus(processId, { state: 'starting', sidecarPid: process.pid });
  let child;
  try {
    const spawnSpec = buildManagedProcessSpawnSpec({
      file: manifest.executable,
      args: manifest.args,
      cwd: manifest.cwd,
      env: manifest.env,
    });
    child = await spawnManagedProcess(spawnSpec, {
      detached: true,
      preserveOnControllerExit: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    await writeManagedProcessStatus(processId, {
      state: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message || String(error),
      sidecarPid: process.pid,
    });
    return 1;
  }

  // Attach completion/output listeners before the first await. A very short
  // process may emit `exit` before the running status write completes.
  let settled = false;
  const completion = new Promise((resolve) => {
    const finish = async (code, signal, error = '') => {
      if (settled) return;
      settled = true;
      const latest = await loadManagedProcessInternal(processId);
      const cancelled = latest?.manifest?.cancelRequested === true;
      const state = cancelled ? 'cancelled' : error ? 'failed' : Number(code) === 0 ? 'completed' : 'failed';
      await writeManagedProcessStatus(processId, {
        state,
        completedAt: new Date().toISOString(),
        exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: text(signal),
        error: error || (state === 'failed' ? `Process exited with code ${code ?? 'unknown'}` : ''),
      }).catch(() => {});
      resolve(state === 'completed' ? 0 : 1);
    };
    child.once('error', (error) => { void finish(null, '', error.message || String(error)); });
    child.once('exit', (code, signal) => { void finish(code, signal); });
  });
  child.stdout?.on('data', (chunk) => { void appendManagedProcessOutput(processId, 'stdout', chunk).catch(() => {}); });
  child.stderr?.on('data', (chunk) => { void appendManagedProcessOutput(processId, 'stderr', chunk).catch(() => {}); });

  await writeManagedProcessStatus(processId, {
    state: 'running',
    pid: Number.isInteger(child.pid) ? child.pid : null,
    sidecarPid: process.pid,
    windowsJobObjectManaged: child.__ragentWindowsManaged === true,
    windowsJobObjectCreation: typeof child.__ragentWindowsJobObjectCreation === 'string'
      ? child.__ragentWindowsJobObjectCreation
      : '',
    startedAt: new Date().toISOString(),
  });

  return await completion;
}

const processId = processIdFromArgs(process.argv.slice(2));
const watchExisting = process.argv.includes('--watch-existing');
if (!processId) process.exitCode = 2;
else run(processId, { watchExisting }).then((code) => { process.exitCode = code; }).catch(async (error) => {
  await writeManagedProcessStatus(processId, {
    state: 'failed',
    completedAt: new Date().toISOString(),
    error: error.message || String(error),
  }).catch(() => {});
  process.exitCode = 1;
});
