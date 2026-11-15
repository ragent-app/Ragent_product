import { execFile as execFileCallback } from 'child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';

import { CHAT_RUNS_DIR, CONFIG_DIR } from './config.mjs';

const execFileAsync = promisify(execFileCallback);
const RESTART_DRAIN_FILE = join(CONFIG_DIR, 'restart-drain.json');
const NON_TERMINAL_STATES = new Set(['accepted', 'starting', 'running', 'cancelling']);
const SYSTEMD_RUNNER_LAUNCH_MODES = new Set([
  'runner-lifecycle',
  'systemd-transient-service',
]);
const DEFAULT_CHAT_UNIT_NAME = 'ragent.service';
const PENDING_RUN_GRACE_MS = 60_000;
const DEFAULT_DRAIN_TTL_MS = 5 * 60_000;

function nowIso() {
  return new Date().toISOString();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isRecordedRunnerProcessAlive(pid, runId) {
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return commandLine.includes('runner-sidecar.mjs') && commandLine.includes(runId);
  } catch {
    return true;
  }
}

async function isSystemdUnitActive(unitName, scope, { execFileImpl = execFileAsync } = {}) {
  if (typeof unitName !== 'string' || !unitName.trim()) return false;
  const args = scope === 'user'
    ? ['--user', 'is-active', '--quiet', unitName]
    : ['is-active', '--quiet', unitName];
  try {
    await execFileImpl('systemctl', args, { timeout: 2_000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function readSystemdUnitProperty(unitName, scope, property, { execFileImpl = execFileAsync } = {}) {
  if (typeof unitName !== 'string' || !unitName.trim()) return '';
  if (typeof property !== 'string' || !property.trim()) return '';
  const args = scope === 'user' ? ['--user'] : [];
  args.push('show', `--property=${property}`, '--value', unitName);
  try {
    const result = await execFileImpl('systemctl', args, { timeout: 2_000, maxBuffer: 64 * 1024 });
    return typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

function normalizeControlGroup(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

/**
 * A runner is independent when neither unit's cgroup contains the other.
 * This is deliberately stricter than checking a changed PPID: the upgrade
 * guarantee depends on systemd ownership, not on process ancestry.
 */
export function isIndependentControlGroup(runnerControlGroup, controlPlaneControlGroup) {
  const runner = normalizeControlGroup(runnerControlGroup);
  const controlPlane = normalizeControlGroup(controlPlaneControlGroup);
  if (!runner || !controlPlane || runner === controlPlane) return false;
  const isDescendant = (candidate, parent) => candidate === parent
    || candidate.startsWith(parent === '/' ? '/' : `${parent}/`);
  return !isDescendant(runner, controlPlane) && !isDescendant(controlPlane, runner);
}

/**
 * Assess whether one active Run can survive an owner control-plane restart.
 * The result is used by package upgrades; ordinary manual restart remains
 * conservative and continues to block on any live Run.
 */
export async function assessRunUpgradeSafety(run, {
  chatUnitName = process.env.RAGENT_CHAT_UNIT_NAME || '',
  execFileImpl = execFileAsync,
} = {}) {
  if (!isSystemdRunnerLaunchMode(run?.runnerLaunchMode)) {
    return { safe: false, reason: 'runner_not_systemd_managed' };
  }
  const runnerUnitName = typeof run?.runnerUnitName === 'string' ? run.runnerUnitName.trim() : '';
  if (!runnerUnitName) return { safe: false, reason: 'runner_unit_missing' };

  const runnerScope = run?.runnerUnitScope === 'user' ? 'user' : 'system';
  const controlPlaneUnitName = chatUnitName
    || (runnerScope === 'user' ? 'ragent-chat.service' : DEFAULT_CHAT_UNIT_NAME);
  const runnerActive = await isSystemdUnitActive(runnerUnitName, runnerScope, { execFileImpl });
  if (!runnerActive) return { safe: false, reason: 'runner_unit_inactive' };

  const runnerControlGroup = await readSystemdUnitProperty(
    runnerUnitName,
    runnerScope,
    'ControlGroup',
    { execFileImpl },
  );
  const controlPlaneControlGroup = await readSystemdUnitProperty(
    controlPlaneUnitName,
    runnerScope,
    'ControlGroup',
    { execFileImpl },
  );
  if (!isIndependentControlGroup(runnerControlGroup, controlPlaneControlGroup)) {
    return {
      safe: false,
      reason: 'runner_control_group_not_independent',
      runnerControlGroup: runnerControlGroup || null,
      controlPlaneControlGroup: controlPlaneControlGroup || null,
    };
  }

  return {
    safe: true,
    reason: 'independent_systemd_runner',
    runnerControlGroup,
    controlPlaneControlGroup,
  };
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function isRecentPendingRun(run, nowMs) {
  if (!['accepted', 'starting'].includes(run?.state)) return false;
  const timestamp = Date.parse(run?.updatedAt || run?.createdAt || '');
  return Number.isFinite(timestamp) && (nowMs - timestamp) <= PENDING_RUN_GRACE_MS;
}

export function isSystemdRunnerLaunchMode(value) {
  return SYSTEMD_RUNNER_LAUNCH_MODES.has(typeof value === 'string' ? value.trim() : '');
}

export async function listBlockingActiveRuns({ nowMs = Date.now(), excludeSessionIds = [] } = {}) {
  const excludedSessions = new Set(
    (Array.isArray(excludeSessionIds) ? excludeSessionIds : [excludeSessionIds])
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean),
  );
  let entries = [];
  try {
    entries = await readdir(CHAT_RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const blocking = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run_')) continue;
    const run = await readJson(join(CHAT_RUNS_DIR, entry.name, 'status.json'));
    if (!run || !NON_TERMINAL_STATES.has(run.state)) continue;
    if (excludedSessions.has(typeof run.sessionId === 'string' ? run.sessionId.trim() : '')) continue;
    const runId = run.id || entry.name;
    const runnerProcessAlive = await isRecordedRunnerProcessAlive(run.runnerProcessId, runId);
    const toolProcessAlive = isProcessAlive(run.toolProcessId);
    const runnerUnitActive = isSystemdRunnerLaunchMode(run.runnerLaunchMode)
      ? await isSystemdUnitActive(run.runnerUnitName, run.runnerUnitScope)
      : false;
    const pendingLaunch = isRecentPendingRun(run, nowMs);
    if (!runnerProcessAlive && !runnerUnitActive && !pendingLaunch) continue;
    blocking.push({
      id: runId,
      sessionId: run.sessionId || null,
      provider: run.provider || null,
      runtimeFamily: run.runtimeFamily || null,
      state: run.state,
      startedAt: run.startedAt || null,
      updatedAt: run.updatedAt || null,
      runnerProcessId: run.runnerProcessId || null,
      toolProcessId: run.toolProcessId || null,
      runnerUnitName: run.runnerUnitName || null,
      runnerUnitScope: run.runnerUnitScope || null,
      runnerLaunchMode: run.runnerLaunchMode || null,
      runnerProcessAlive,
      toolProcessAlive,
      runnerUnitActive,
      pendingLaunch,
    });
  }
  return blocking.sort((left, right) => String(left.startedAt || left.updatedAt || '').localeCompare(String(right.startedAt || right.updatedAt || '')));
}

export async function listUpgradeActiveRuns(options = {}) {
  const activeRuns = await listBlockingActiveRuns(options);
  return Promise.all(activeRuns.map(async (run) => ({
    ...run,
    ...(await assessRunUpgradeSafety(run, options)),
  })));
}

export async function listUpgradeBlockingActiveRuns(options = {}) {
  const activeRuns = await listUpgradeActiveRuns(options);
  return activeRuns.filter((run) => run.safe !== true);
}

export async function readRestartDrain() {
  const drain = await readJson(RESTART_DRAIN_FILE);
  if (!drain) return null;
  const expiresAtMs = Date.parse(drain.expiresAt || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await rm(RESTART_DRAIN_FILE, { force: true });
    return null;
  }
  return drain;
}

export async function assertRunStartsAllowed() {
  const drain = await readRestartDrain();
  if (!drain) return;
  const error = new Error('Ragent is preparing to restart; new runs are temporarily paused');
  error.code = 'RESTART_DRAINING';
  error.retryAfterMs = Math.max(1_000, Date.parse(drain.expiresAt) - Date.now());
  throw error;
}

export async function beginRestartDrain({
  force = false,
  ttlMs = DEFAULT_DRAIN_TTL_MS,
  reason = 'service-restart',
  excludeSessionIds = [],
  allowSafeActiveRuns = false,
  chatUnitName = process.env.RAGENT_CHAT_UNIT_NAME || '',
  execFileImpl = execFileAsync,
} = {}) {
  const startedAt = nowIso();
  const drain = {
    version: 1,
    mode: allowSafeActiveRuns ? 'upgrade' : 'restart',
    reason,
    force: force === true,
    ownerPid: process.pid,
    startedAt,
    expiresAt: new Date(Date.now() + Math.max(30_000, ttlMs)).toISOString(),
  };
  await writeJsonAtomic(RESTART_DRAIN_FILE, drain);
  const blockingRuns = allowSafeActiveRuns
    ? await listUpgradeBlockingActiveRuns({ excludeSessionIds, chatUnitName, execFileImpl })
    : await listBlockingActiveRuns({ excludeSessionIds });
  if (blockingRuns.length > 0 && !force) {
    await endRestartDrain();
    return { ok: false, drain: null, blockingRuns };
  }
  return { ok: true, drain, blockingRuns };
}

export async function beginUpgradeDrain(options = {}) {
  return beginRestartDrain({
    ...options,
    allowSafeActiveRuns: true,
    reason: options.reason || 'package-upgrade',
  });
}

export async function endRestartDrain() {
  await rm(RESTART_DRAIN_FILE, { force: true });
}

export async function clearRestartDrainAfterStartup() {
  await rm(RESTART_DRAIN_FILE, { force: true });
}

export { RESTART_DRAIN_FILE };
