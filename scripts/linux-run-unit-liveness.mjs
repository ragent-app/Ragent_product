// The expected identity must come from root-controlled launch state, never the
// operation request. A live systemd unit alone does not prove authorization,
// absence of cancellation, or continued liveness after this check.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const runSystemctl = promisify(execFile);
const RUN_ID = /^run_[A-Za-z0-9_-]{8,128}$/;
const INVOCATION_ID = /^[a-f0-9]{32}$/;
const KEYS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'ControlGroup'];

export function linuxRunUnitName(runId, launchAttempt) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || !Number.isSafeInteger(launchAttempt) ||
      launchAttempt < 0 || launchAttempt > 10000) throw new Error('Invalid Run unit identity');
  return `agentoc-runner-${runId}${launchAttempt ? `-a${launchAttempt}` : ''}.service`;
}

export function matchesLinuxRunUnitState(output, { runId, launchAttempt, invocationId } = {}) {
  try {
    const unit = linuxRunUnitName(runId, launchAttempt);
    if (typeof invocationId !== 'string' || !INVOCATION_ID.test(invocationId) || /^0+$/.test(invocationId) ||
        typeof output !== 'string' || output.length > 16384) return false;
    const values = Object.create(null);
    for (const line of output.split('\n')) {
      if (!line) continue;
      const separator = line.indexOf('=');
      if (separator < 1) return false;
      const key = line.slice(0, separator), value = line.slice(separator + 1);
      if (!KEYS.includes(key) || Object.hasOwn(values, key)) return false;
      values[key] = value;
    }
    return KEYS.every((key) => Object.hasOwn(values, key)) && values.Id === unit &&
      values.LoadState === 'loaded' && values.ActiveState === 'active' && values.SubState === 'running' &&
      /^[1-9][0-9]*$/.test(values.MainPID) && Number.isSafeInteger(Number(values.MainPID)) &&
      values.InvocationID === invocationId && values.ControlGroup === `/agentoc.slice/agentoc-runners.slice/${unit}`;
  } catch { return false; }
}

// Only the root lifecycle broker that just created the unit may capture this
// identity. An existing unit of the same name is not evidence of a launch.
export function parseLinuxRunProcessIdentity(status, stat, expectedUid) {
  try {
    if (!Number.isSafeInteger(expectedUid) || expectedUid <= 0 || expectedUid > 0xfffffffe ||
        typeof status !== 'string' || status.length > 65536 || typeof stat !== 'string' || stat.length > 65536) return null;
    const lines = status.split('\n').filter((line) => line.startsWith('Uid:'));
    const fields = lines.length === 1 ? lines[0].slice(4).trim().split(/\s+/) : [];
    if (fields.length !== 4 || fields.some((field) => !/^\d+$/.test(field) || Number(field) !== expectedUid)) return null;
    const noNewPrivileges = status.split('\n').filter((line) => line.startsWith('NoNewPrivs:'));
    if (noNewPrivileges.length !== 1 || noNewPrivileges[0].slice('NoNewPrivs:'.length).trim() !== '1') return null;
    // comm is parenthesized and can itself contain spaces and parentheses.
    const close = stat.lastIndexOf(')');
    const rest = close < 0 ? [] : stat.slice(close + 1).trim().split(/\s+/);
    const startTime = rest[19]; // /proc/<pid>/stat field 22
    return /^(0|[1-9][0-9]*)$/.test(startTime || '') ? { uid: expectedUid, startTime } : null;
  } catch { return null; }
}

export async function captureLinuxRunUnitIdentity({ runId, launchAttempt, runnerUid } = {}) {
  try {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !Number.isSafeInteger(runnerUid) || runnerUid <= 0) return null;
    const unit = linuxRunUnitName(runId, launchAttempt);
    const args = ['show', ...KEYS.map((key) => `--property=${key}`), '--', unit];
    const options = { timeout: 2000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LANG: 'C' } };
    const { stdout } = await runSystemctl('/usr/bin/systemctl', args, options);
    const ids = stdout.split('\n').filter((line) => line.startsWith('InvocationID='));
    const pids = stdout.split('\n').filter((line) => line.startsWith('MainPID='));
    if (ids.length !== 1 || pids.length !== 1) return null;
    const pid = Number(pids[0].slice('MainPID='.length));
    const identity = { runId, launchAttempt, invocationId: ids[0].slice('InvocationID='.length) };
    if (!matchesLinuxRunUnitState(stdout, identity)) return null;
    const [status, stat] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
    const processIdentity = parseLinuxRunProcessIdentity(status, stat, runnerUid);
    if (!processIdentity) return null;
    const recheck = await runSystemctl('/usr/bin/systemctl', args, options);
    if (recheck.stdout !== stdout) return null;
    return { ...identity, runnerUid, mainPid: pid, startTime: processIdentity.startTime };
  } catch { return null; }
}

export async function isLinuxRunUnitLive(expected) {
  const actual = await captureLinuxRunUnitIdentity(expected);
  return actual !== null && actual.invocationId === expected?.invocationId && actual.mainPid === expected?.mainPid &&
    actual.startTime === expected?.startTime;
}
