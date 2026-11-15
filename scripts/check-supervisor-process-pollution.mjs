#!/usr/bin/env node
// DS-02: alarm-only diagnostic for processes inside the runner-supervisor cgroup.
//
// The runner supervisor (ragent-runner-supervisor.service, KillMode=process)
// is a pure launcher: it is allowed to contain exactly two kinds of processes:
//   - the supervisor daemon itself (runner-supervisor-daemon.mjs)
//   - supervised runner sidecars (runner-sidecar.mjs <runId>) whose argv carries
//     the run manifest marker (run_...) — the "child must carry a run manifest /
//     instance marker" contract.
//
// Anything else found inside that cgroup is pollution and is reported here.
// Known pollution classes from the audit snapshot: duplicate chat-server.mjs,
// stress drivers (stress/marathon/sysbench), diag-host-v47b.mjs style
// diagnostic scripts, long-running journalctl -f tails, sleep loops.
//
// IMPORTANT: this script is read-only and ALARM-ONLY. It never kills, never
// writes to the unit, never restarts services. Humans decide what to do with
// the report.
//
// Usage:
//   node scripts/check-supervisor-process-pollution.mjs [--json] [--unit <name>]
//        [--cgroup-dir <dir>] [--long-running-hours <n>]
//
// Options:
//   --json                  machine-readable JSON on stdout
//   --unit <name>           systemd unit whose cgroup to inspect (default:
//                           ragent-runner-supervisor.service)
//   --cgroup-dir <dir>      read <dir>/cgroup.procs instead of auto-discovery
//                           (used by tests to simulate a cgroup)
//   --long-running-hours <n>  elapsed threshold for the long-running heuristic
//                           (default 24)
//   -h, --help              usage
//
// Exit codes: 0 = clean (or unit not present on this host); 1 = pollution
// detected; 2 = inspection error (cgroup/proc unreadable).

import { readdir, readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const RUN_MANIFEST_ID_RE = /^run_[A-Za-z0-9_-]{8,128}$/;
const STRESS_DRIVER_TOKENS = new Set(['stress', 'stress-ng', 'sysbench', 'marathon', 'yes']);
const TEST_TOKENS = new Set(['mocha', 'vitest', 'jest', 'nyc']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseArgs(argv) {
  const options = {
    json: false,
    unit: 'ragent-runner-supervisor.service',
    cgroupDir: '',
    longRunningHours: 24,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const value = (flag) => {
      const inline = arg.startsWith(`${flag}=`);
      if (inline) return arg.slice(flag.length + 1);
      index += 1;
      return argv[index] ?? '';
    };
    if (arg === '--unit' || arg.startsWith('--unit=')) options.unit = value('--unit');
    else if (arg === '--cgroup-dir' || arg.startsWith('--cgroup-dir=')) options.cgroupDir = value('--cgroup-dir');
    else if (arg === '--long-running-hours' || arg.startsWith('--long-running-hours=')) {
      options.longRunningHours = Number.parseInt(value('--long-running-hours'), 10);
    }
  }
  return options;
}

async function readCmdline(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.toString('utf8').split('\0').filter((part) => part.length > 0);
  } catch {
    return null;
  }
}

async function readComm(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/comm`);
    return trimString(raw.toString('utf8'));
  } catch {
    return null;
  }
}

async function readEnviron(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    return raw.toString('utf8').split('\0');
  } catch {
    return null;
  }
}

async function readElapsedSeconds(pid, clockTicksPerSec = 100) {
  try {
    const [uptimeRaw, statRaw] = await Promise.all([
      readFile('/proc/uptime', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const uptime = Number.parseFloat(uptimeRaw.split(' ')[0] ?? '0');
    // stat: comm may contain spaces/parens; starttime is the field AFTER the
    // last ')' — robust parse.
    const right = statRaw.slice(statRaw.lastIndexOf(')') + 1).trim().split(/\s+/);
    const startTicks = Number.parseFloat(right[19]); // field 22 overall -> index 19 after comm
    if (!Number.isFinite(startTicks)) return null;
    return Math.max(0, uptime - startTicks / clockTicksPerSec);
  } catch {
    return null;
  }
}

function classifyProcess({ argv, comm, environ, elapsedSeconds, longRunningHours }) {
  const tokens = [...argv, comm].filter(Boolean);
  const joined = tokens.join(' ');

  // Marker contract violations are reported regardless of the rest.
  const instanceMarker = environ?.find((entry) => entry.startsWith('RAGENT_TEST_INSTANCE_ID='));
  const runnerMarkerPresent = tokens.some((token) => RUN_MANIFEST_ID_RE.test(token));

  if (tokens.some((token) => token.includes('runner-supervisor-daemon.mjs'))) {
    return { role: 'allowed', kind: 'supervisor-daemon', severity: 0 };
  }
  if (tokens.some((token) => token.includes('runner-sidecar.mjs'))) {
    if (runnerMarkerPresent) {
      return { role: 'allowed', kind: 'supervised-runner', severity: 0, manifestMarker: true };
    }
    return {
      role: 'pollution',
      kind: 'sidecar-without-run-manifest-marker',
      severity: 3,
      reason: 'runner-sidecar.mjs child without a run_... manifest marker in argv',
    };
  }

  if (instanceMarker) {
    return {
      role: 'pollution',
      kind: 'test-instance-in-prod-cgroup',
      severity: 4,
      reason: `process carries test instance marker ${instanceMarker.split('=')[1]}`,
    };
  }
  if (tokens.some((token) => token.includes('chat-server.mjs'))) {
    return { role: 'pollution', kind: 'duplicate-chat-server', severity: 4, reason: 'a second chat-server.mjs runs inside the supervisor cgroup' };
  }
  if (tokens.some((token) => token.includes('journalctl'))) {
    return { role: 'pollution', kind: 'journalctl-tail', severity: 2, reason: 'journalctl -f style long-running log tail' };
  }
  if (tokens.some((token) => STRESS_DRIVER_TOKENS.has(token))) {
    return { role: 'pollution', kind: 'stress-driver', severity: 3, reason: 'stress/load-generation driver' };
  }
  if (tokens.some((token) => token.includes('diag-'))) {
    return { role: 'pollution', kind: 'diagnostic-script', severity: 3, reason: 'diag-* diagnostic script' };
  }
  if (comm === 'sleep' || tokens.some((token) => token === 'sleep')) {
    return { role: 'pollution', kind: 'sleep-process', severity: 1, reason: 'sleep process' };
  }
  if (tokens.some((token) => TEST_TOKENS.has(token)) || joined.includes('tests/test')) {
    return { role: 'pollution', kind: 'test-process', severity: 3, reason: 'test harness process' };
  }
  if (tokens.some((token) => ['npm', 'yarn', 'pnpm'].includes(token))) {
    return { role: 'pollution', kind: 'package-manager', severity: 2, reason: 'package manager process' };
  }

  const longRunning = elapsedSeconds !== null && elapsedSeconds > longRunningHours * 3600;
  if (longRunning) {
    return {
      role: 'pollution',
      kind: 'long-running-unknown',
      severity: 2,
      reason: `unknown process running ${Math.floor(elapsedSeconds / 3600)}h inside supervisor cgroup`,
    };
  }
  return { role: 'pollution', kind: 'unknown-process', severity: 1, reason: 'unexpected process inside supervisor cgroup' };
}

async function readParentPid(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const parent = Number.parseInt(tail[1], 10); // field 4 overall
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

async function discoverSupervisorPids({ unit, cgroupDir = '' }) {
  if (cgroupDir) {
    const procsFile = `${cgroupDir}/cgroup.procs`;
    const raw = await readFile(procsFile, 'utf8');
    return {
      pids: raw.split(/\s+/).map(trimString).filter(Boolean).map(Number),
      supervisorPid: null,
    };
  }

  // Scan /proc/*/cgroup for any process attached to the unit's cgroup. Works on
  // both cgroup v1 and v2 without needing /sys/fs/cgroup access.
  const unitKey = unit.replace(/\.service$/, '');
  const pids = new Set();
  let supervisorPid = null;
  const procEntries = await readdir('/proc');
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cgroupText = await readFile(`/proc/${entry}/cgroup`, 'utf8');
      if (!cgroupText.includes(unitKey)) continue;
      const pid = Number.parseInt(entry, 10);
      pids.add(pid);
      const cmdline = await readCmdline(pid);
      if (cmdline?.some((token) => token.includes('runner-supervisor-daemon.mjs'))) {
        supervisorPid = pid;
      }
    } catch {
      // Process vanished between readdir and read; skip.
    }
  }
  return { pids: [...pids], supervisorPid };
}

async function inspectPids(pids, { longRunningHours }) {
  const processes = [];
  const facts = new Map();
  for (const pid of pids) {
    const [argv, comm, environ, elapsedSeconds, parentPid] = await Promise.all([
      readCmdline(pid),
      readComm(pid),
      readEnviron(pid),
      readElapsedSeconds(pid),
      readParentPid(pid),
    ]);
    if (argv === null && comm === null) {
      // Nothing readable: the process vanished, or it belongs to another user
      // and is already reaped. Do not guess — count it and move on.
      processes.push({ pid, inspectable: false, role: 'unknown' });
      continue;
    }
    facts.set(pid, { argv: argv ?? [], comm: comm ?? '', environ, elapsedSeconds, parentPid });
  }
  const sidecarPids = new Set(
    [...facts.entries()]
      .filter(([, fact]) => (
        fact.argv.some((token) => token.includes('runner-sidecar.mjs'))
        && fact.argv.some((token) => RUN_MANIFEST_ID_RE.test(token))
      ))
      .map(([pid]) => pid),
  );
  const descendantOfSidecar = (pid) => {
    const seen = new Set();
    // Do not treat a sidecar as its own descendant.  In particular, a
    // marker-less runner-sidecar must remain pollution instead of being
    // reclassified as an allowed run-descendant.  Only children/grandchildren
    // of a positively identified supervised runner inherit the allowance.
    let current = facts.get(pid)?.parentPid;
    for (let depth = 0; depth < 64; depth += 1) {
      if (sidecarPids.has(current)) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const parent = facts.get(current)?.parentPid;
      if (!parent || parent === current || parent === 1) return false;
      current = parent;
    }
    return false;
  };
  for (const pid of pids) {
    const fact = facts.get(pid);
    if (!fact) continue;
    const { argv, comm, environ, elapsedSeconds } = fact;
    const classification = classifyProcess({
      argv,
      comm,
      environ,
      elapsedSeconds,
      longRunningHours,
    });
    if (classification.role === 'pollution' && descendantOfSidecar(pid)) {
      classification.role = 'allowed';
      classification.kind = 'run-descendant';
      classification.severity = 0;
      classification.reason = '';
    }
    processes.push({
      pid,
      inspectable: true,
      role: classification.role,
      kind: classification.kind,
      severity: classification.severity ?? 0,
      reason: classification.reason ?? '',
      cmdline: argv ?? null,
      comm: comm ?? null,
      elapsedSeconds,
      instanceMarker: environ?.find((entry) => entry.startsWith('RAGENT_TEST_INSTANCE_ID=')) ?? null,
    });
  }
  return processes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: node scripts/check-supervisor-process-pollution.mjs [options]

Alarm-only diagnostic for processes inside the runner-supervisor cgroup.
Reads /proc and (optionally) systemd; never kills, never modifies the unit.

Options:
  --json                   machine-readable JSON on stdout
  --unit <name>            unit to inspect (default ragent-runner-supervisor.service)
  --cgroup-dir <dir>       read <dir>/cgroup.procs instead of auto-discovery (tests)
  --long-running-hours <n> elapsed threshold for long-running heuristic (default 24)
  -h, --help               this help

Exit codes: 0 = clean/unit absent; 1 = pollution found; 2 = inspection error.
`);
    process.exit(0);
  }

  let pids = [];
  let supervisorPid = null;
  let found = true;
  let discoveredVia = 'proc-scan';
  let error = null;

  try {
    if (options.cgroupDir) {
      discoveredVia = 'cgroup-dir';
      const discovered = await discoverSupervisorPids({ unit: options.unit, cgroupDir: options.cgroupDir });
      pids = discovered.pids;
      supervisorPid = discovered.supervisorPid;
    } else {
      // Prefer systemd MainPID for an authoritative cgroup membership check,
      // then fall back to the /proc scan.
      try {
        const { stdout } = await execFileAsync(
          'systemctl', ['show', '-p', 'MainPID', '--value', options.unit],
          { timeout: 3000, maxBuffer: 4096 },
        );
        const mainPid = Number.parseInt(trimString(stdout), 10);
        if (Number.isInteger(mainPid) && mainPid > 0) {
          const discovered = await discoverSupervisorPids({ unit: options.unit, cgroupDir: '' });
          pids = discovered.pids;
          supervisorPid = discovered.supervisorPid ?? mainPid;
          if (pids.length === 0) {
            // Unit exists but cgroup is empty (no runs, supervisor itself not
            // found — e.g. it is currently down).
            pids = [mainPid];
          }
        } else {
          found = false;
        }
      } catch {
        const discovered = await discoverSupervisorPids({ unit: options.unit, cgroupDir: '' });
        pids = discovered.pids;
        supervisorPid = discovered.supervisorPid;
        found = pids.length > 0;
        if (!found) discoveredVia = 'none';
      }
    }
  } catch (inspectionError) {
    error = inspectionError?.message || String(inspectionError);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error,
        unit: options.unit,
        checkedAt: new Date().toISOString(),
        pollutionCount: 0,
        processes: [],
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`[check-supervisor-process-pollution] inspection error: ${error}\n`);
    }
    process.exit(2);
  }

  const processes = await inspectPids(pids, { longRunningHours: options.longRunningHours });
  const pollution = processes.filter((process) => process.role === 'pollution');
  const clean = processes.filter((process) => process.role === 'allowed');
  const gone = processes.filter((process) => !process.inspectable);

  if (!options.json) {
    process.stdout.write(`[check-supervisor-process-pollution] unit=${options.unit} cgroup=${discoveredVia}\n`);
    process.stdout.write(`[check-supervisor-process-pollution] found=${found} supervisorPid=${supervisorPid ?? '-'} total=${processes.length} clean=${clean.length} pollution=${pollution.length} gone=${gone.length}\n`);
    for (const entry of clean) {
      process.stdout.write(`  ok    pid=${entry.pid} kind=${entry.kind}${entry.manifestMarker ? ' manifest=run_...' : ''}\n`);
    }
    for (const entry of pollution) {
      const elapsed = entry.elapsedSeconds === null ? '?' : `${Math.floor(entry.elapsedSeconds / 60)}m`;
      process.stdout.write(`  ALARM pid=${entry.pid} kind=${entry.kind} severity=${entry.severity} elapsed=${elapsed} cmdline=${(entry.cmdline ?? []).join(' ')}\n`);
      process.stdout.write(`        ${entry.reason}\n`);
    }
    for (const entry of gone) {
      process.stdout.write(`  note  pid=${entry.pid} vanished during inspection (skipped)\n`);
    }
    if (pollution.length === 0 && found) {
      process.stdout.write('[check-supervisor-process-pollution] CLEAN: no pollution detected (alarm-only, nothing was killed)\n');
    } else if (!found) {
      process.stdout.write(`[check-supervisor-process-pollution] unit ${options.unit} not present on this host; nothing to check\n`);
    }
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: pollution.length === 0,
      found,
      unit: options.unit,
      cgroup: discoveredVia,
      supervisorPid,
      checkedAt: new Date().toISOString(),
      totalCount: processes.length,
      cleanCount: clean.length,
      pollutionCount: pollution.length,
      goneCount: gone.length,
      processes: processes.map((process) => ({
        pid: process.pid,
        role: process.role,
        kind: process.kind ?? null,
        severity: process.severity ?? null,
        reason: process.reason ?? null,
        cmdline: process.cmdline,
        comm: process.comm,
        elapsedSeconds: process.elapsedSeconds,
        instanceMarker: process.instanceMarker,
      })),
      pollution: pollution.map((process) => process.pid),
      actionTaken: 'none (alarm-only)',
    }, null, 2)}\n`);
  }
  process.exit(pollution.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(`[check-supervisor-process-pollution] fatal: ${error?.message || String(error)}\n`);
  process.exit(2);
});
