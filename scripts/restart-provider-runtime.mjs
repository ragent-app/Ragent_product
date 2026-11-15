#!/usr/bin/env node
// Restart-time provider runtime hygiene (native-only).
//
// The legacy cc-switch runtime is retired: no daemon is expected, and stale
// vendor processes from an older install are only ever cleaned up here, never
// converged back to a desired state.  --stop signals any surviving cc-switch
// daemon/serve process so service restarts cannot race a dead runtime's
// proxy port; --verify asserts none is running.

import { readdir, readFile } from 'node:fs/promises';

const DEFAULT_CC_SWITCH_COMMAND = '/opt/ragent/vendor/cc-switch/cc-switch';
const STOP_GRACE_MS = 2_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function configuredCommand(environment = process.env) {
  return trimString(environment.RAGENT_CC_SWITCH_COMMAND) || DEFAULT_CC_SWITCH_COMMAND;
}

function commandMatches(tokens, commandPath) {
  const expected = commandPath.replace(/\\/g, '/');
  return tokens.some((token) => {
    const normalized = String(token || '').replace(/\\/g, '/');
    return normalized === expected || (
      normalized.endsWith('/cc-switch')
      && normalized.includes('/vendor/cc-switch/')
    );
  });
}

export async function listProviderRuntimeProcesses({
  procRoot = '/proc',
  commandPath = configuredCommand(),
} = {}) {
  const processes = [];
  let entries;
  try {
    entries = await readdir(procRoot, { withFileTypes: true });
  } catch {
    return processes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    if (Number.parseInt(entry.name, 10) === process.pid) continue;
    try {
      const tokens = (await readFile(`${procRoot}/${entry.name}/cmdline`, 'utf8')).split('\0');
      if (!commandMatches(tokens, commandPath)) continue;
      if (!tokens.includes('daemon') && !tokens.includes('serve')) continue;
      processes.push({ pid: Number.parseInt(entry.name, 10), cmdline: tokens.join(' ').trim() });
    } catch {
      // The process may exit between /proc enumeration and cmdline read.
    }
  }
  return processes;
}

async function signalProviderRuntimeProcesses({ signal, procRoot, commandPath }) {
  const processes = await listProviderRuntimeProcesses({ procRoot, commandPath });
  for (const proc of processes) {
    try {
      process.kill(proc.pid, signal);
    } catch {
      // Already gone — the goal is only that it stops.
    }
  }
  return processes.length;
}

export async function stopProviderRuntime({
  environment = process.env,
  procRoot = '/proc',
  waitMs = STOP_GRACE_MS,
} = {}) {
  const commandPath = configuredCommand(environment);
  const signalled = await signalProviderRuntimeProcesses({ signal: 'SIGTERM', procRoot, commandPath });
  let forceKilled = 0;
  if (signalled > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    forceKilled = await signalProviderRuntimeProcesses({ signal: 'SIGKILL', procRoot, commandPath });
  }
  return { ok: true, signalled, forceKilled };
}

export async function verifyProviderRuntime({
  environment = process.env,
  procRoot = '/proc',
} = {}) {
  const stale = (await listProviderRuntimeProcesses({
    procRoot,
    commandPath: configuredCommand(environment),
  })).length;
  return { ok: stale === 0, mode: 'native', expected: false };
}

async function main() {
  const command = process.argv[2] || '--verify';
  if (command === '--stop') {
    const result = await stopProviderRuntime();
    console.log(`provider runtime: stopped ${result.signalled} stale cc-switch process records${result.forceKilled ? ` (${result.forceKilled} force-killed)` : ''}`);
    return;
  }
  if (command === '--verify') {
    const result = await verifyProviderRuntime();
    console.log(`provider runtime: ${result.mode} ${result.ok ? 'healthy' : 'stale cc-switch process still running'}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
