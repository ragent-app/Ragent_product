import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { isEnvToggleEnabled } from './env-toggle.mjs';

const execFileAsync = promisify(execFile);

// SubStates systemd moves a unit through while deactivating it. Any of these
// means the unit is on its way to SIGKILL after TimeoutStopSec unless the
// main process exits on its own.
const STOPPING_SUBSTATES = new Set([
  'deactivating',
  'stop',
  'stop-pre',
  'stop-sigterm',
  'stop-sigkill',
  'stop-post',
  'final-sigterm',
  'final-sigkill',
  'cleanup',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isStoppingSubState(subState) {
  return STOPPING_SUBSTATES.has(trimString(subState));
}

// The system unit this process lives in, derived from the v2 cgroup path
// ("0::/system.slice/ragent.service"). Empty outside a systemd system unit,
// which is how dev runs, per-Run runner units, and non-Linux platforms opt
// out of the detector entirely.
export function detectOwnSystemdUnit(cgroupText) {
  for (const line of String(cgroupText || '').split('\n')) {
    const match = line.match(/^0::\/system\.slice\/([A-Za-z0-9@.:\\_-]+\.service)$/);
    if (match) return match[1];
  }
  return '';
}

export async function readOwnSystemdUnit() {
  try {
    return detectOwnSystemdUnit(readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {
    return '';
  }
}

// systemd hands the unit's notify channel to every child through these vars,
// and systemctl actively uses them: each spawned `systemctl` sends an
// `EXIT_STATUS=...` datagram to the unit's notify socket on exit (observed on
// systemd 255). Under NotifyAccess=all that let a polling child speak for the
// whole unit; under NotifyAccess=main it still produces one rejected-message
// journal line per probe (~43k/day at the 2s cadence). Strip the channel so
// the probe never carries unit-control credentials at all.
const UNIT_NOTIFY_ENV_KEYS = [
  'NOTIFY_SOCKET',
  'RAGENT_NOTIFY_FD',
  'WATCHDOG_PID',
  'WATCHDOG_USEC',
];

export function sanitizeSystemctlEnv(env = process.env) {
  const clean = { ...env };
  for (const key of UNIT_NOTIFY_ENV_KEYS) delete clean[key];
  return clean;
}

export async function showUnitSubState(unit) {
  const { stdout } = await execFileAsync(
    'systemctl',
    ['show', unit, '--property=SubState', '--value'],
    { env: sanitizeSystemctlEnv(process.env), timeout: 2_000 },
  );
  return trimString(stdout.split('\n', 1)[0] || '');
}

// Forensic one-liner. SigPnd is the discriminating bit: set means the SIGTERM
// reached the process but was never dequeued by the event loop; clear at
// stop-detection time means the signal never pended here at all.
export function describeSignalForensics(statusText = '', pid = process.pid) {
  const pick = (name) => String(statusText).match(new RegExp(`^${name}:\\s+(\\S+)`, 'm'))?.[1] || '?';
  return `pid=${pid} SigPnd=${pick('SigPnd')} SigIgn=${pick('SigIgn')} SigCgt=${pick('SigCgt')}`;
}

function readStatusSafely() {
  try {
    return readFileSync('/proc/self/status', 'utf8');
  } catch {
    return '';
  }
}

/**
 * Polls the owning systemd unit's SubState and fires once when the unit is
 * being deactivated. A failing `systemctl` must never fire the detector, and
 * one stopping sample alone is not enough: `consecutiveHits` guards against a
 * transient odd answer. Env kill switch: RAGENT_SELF_STOP_DETECTOR=off.
 */
export function startSelfStopDetector(options = {}) {
  const env = options.env || process.env;
  if (!isEnvToggleEnabled(env.RAGENT_SELF_STOP_DETECTOR, { defaultValue: true })) {
    return { active: false, unit: '', stop() {} };
  }
  const intervalMs = Number.isInteger(options.intervalMs) ? options.intervalMs : 2_000;
  const consecutiveHits = Number.isInteger(options.consecutiveHits) ? options.consecutiveHits : 2;
  const startDelayMs = Number.isInteger(options.startDelayMs) ? options.startDelayMs : 15_000;
  const showFn = options.showFn || showUnitSubState;
  const onDetected = options.onDetected || (() => {});
  const state = { active: true, unit: trimString(options.unit) };
  let timer = null;
  let stopped = false;
  let fired = false;
  let busy = false;
  let hits = 0;

  function halt() {
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      timer.unref?.();
      timer = null;
    }
  }

  async function tick() {
    if (stopped || fired || busy) return;
    busy = true;
    try {
      if (!state.unit) {
        state.unit = await readOwnSystemdUnit();
        if (!state.unit) {
          state.active = false;
          halt();
          return;
        }
      }
      const subState = await showFn(state.unit);
      if (!isStoppingSubState(subState)) {
        hits = 0;
        return;
      }
      hits += 1;
      if (hits < consecutiveHits) return;
      fired = true;
      halt();
      const detail = describeSignalForensics(readStatusSafely());
      console.error(`[self-stop-detector] ${state.unit} is stopping (SubState=${subState}); ${detail}`);
      onDetected({ unit: state.unit, subState, detail });
    } catch {
      hits = 0;
    } finally {
      busy = false;
    }
  }

  timer = setTimeout(() => {
    timer = setInterval(tick, intervalMs);
    void tick();
  }, startDelayMs);
  timer.unref?.();

  return {
    get active() {
      return state.active;
    },
    get unit() {
      return state.unit;
    },
    stop() {
      stopped = true;
      halt();
    },
  };
}
