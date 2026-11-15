// Runner fleet admission guard.
//
// The control plane must stop accepting new provider processes before the
// runner slice can starve it. Linux reads cgroup v2 directly (no systemctl
// child process on the request path); other platforms keep the concurrency
// contract and can supply an adapter snapshot as their runner implementation
// gains equivalent accounting.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DEFAULTS = Object.freeze({
  maxConcurrentRuns: 12,
  maxMemoryBytes: 24 * GiB,
  maxTasks: 1024,
});

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveBytes(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRunnerCapacityLimits(environment = process.env) {
  return {
    maxConcurrentRuns: readPositiveInt(environment?.RAGENT_RUN_CAPACITY_MAX_CONCURRENT, DEFAULTS.maxConcurrentRuns),
    maxMemoryBytes: readPositiveBytes(environment?.RAGENT_RUN_CAPACITY_MAX_MEMORY_BYTES, DEFAULTS.maxMemoryBytes),
    maxTasks: readPositiveInt(environment?.RAGENT_RUN_CAPACITY_MAX_TASKS, DEFAULTS.maxTasks),
  };
}

function parseCgroupNumber(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === 'max') return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function runnerUnitName(value) {
  return /^ragent-runner-run_[A-Za-z0-9_-]+\.service$/.test(value);
}

export async function readLinuxRunnerFleetSnapshot({
  roots = [
    '/sys/fs/cgroup/ragent.slice/ragent-runners.slice',
    '/sys/fs/cgroup/ragent-runners.slice',
  ],
  readFileImpl = readFile,
  readdirImpl = readdir,
} = {}) {
  for (const root of roots) {
    try {
      const [memoryCurrent, pidsCurrent, children] = await Promise.all([
        readFileImpl(join(root, 'memory.current'), 'utf8'),
        readFileImpl(join(root, 'pids.current'), 'utf8'),
        readdirImpl(root),
      ]);
      const unitNames = children.filter(runnerUnitName).sort();
      return {
        root,
        activeRuns: unitNames.length,
        activeRunnerUnits: unitNames,
        memoryCurrentBytes: parseCgroupNumber(memoryCurrent),
        pidsCurrent: parseCgroupNumber(pidsCurrent),
      };
    } catch {}
  }
  return null;
}

export function evaluateRunnerCapacity(snapshot, limits = DEFAULTS) {
  const reasons = [];
  if (Number.isInteger(snapshot?.activeRuns) && snapshot.activeRuns >= limits.maxConcurrentRuns) reasons.push('concurrency');
  if (Number.isInteger(snapshot?.memoryCurrentBytes) && snapshot.memoryCurrentBytes >= limits.maxMemoryBytes) reasons.push('memory');
  if (Number.isInteger(snapshot?.pidsCurrent) && snapshot.pidsCurrent >= limits.maxTasks) reasons.push('tasks');
  return { accepted: reasons.length === 0, reasons, limits, snapshot };
}

export async function checkRunnerCapacity({
  platform = process.platform,
  environment = process.env,
  readSnapshot = null,
} = {}) {
  if (String(environment?.RAGENT_RUN_CAPACITY_GUARD || 'on').trim().toLowerCase() === 'off') {
    return { accepted: true, reasons: [], limits: resolveRunnerCapacityLimits(environment), snapshot: null, bypassed: true };
  }
  const snapshot = typeof readSnapshot === 'function'
    ? await readSnapshot()
    : (platform === 'linux' ? await readLinuxRunnerFleetSnapshot() : null);
  return evaluateRunnerCapacity(snapshot, resolveRunnerCapacityLimits(environment));
}

export const RUNNER_CAPACITY_DEFAULTS = DEFAULTS;
