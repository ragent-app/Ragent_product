import { execFile } from 'node:child_process';
import { writeSync } from 'node:fs';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const execFileAsync = promisify(execFile);
const DEFAULT_NOTIFY_COMMAND = '/usr/bin/systemd-notify';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isSystemdNotifyAvailable(env = process.env) {
  return Boolean(trimString(env.NOTIFY_SOCKET));
}

// The notify-exec wrapper (see packaging/deb/notify-exec) connects the unit's
// notify socket before exec'ing Node and hands the descriptor over via this
// env var. Writing the datagrams from this exact pid is what makes the unit
// safe to run with NotifyAccess=main: no child process can speak for it.
export function resolveNotifyFd(env = process.env) {
  const fd = Number.parseInt(trimString(env.RAGENT_NOTIFY_FD), 10);
  return Number.isInteger(fd) && fd > 2 ? fd : null;
}

// Canonical sd_notify wire format. STATUS is single-line by protocol.
export function buildNotifyMessage(fields = {}) {
  const lines = [];
  if (fields.ready === true) lines.push('READY=1');
  if (fields.watchdog === true) lines.push('WATCHDOG=1');
  const status = trimString(fields.status).replace(/[\r\n]+/g, ' ');
  if (status) lines.push(`STATUS=${status}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// write(2) on a connected AF_UNIX SOCK_DGRAM socket sends one datagram per
// call. EAGAIN means systemd's receive buffer was momentarily full; one retry
// covers the watchdog case and the next tick recovers the rest.
//
// Any other failure must be visible: a lost descriptor (closed and never
// reused, or reused by a non-socket) starves the watchdog and systemd
// SIGABRTs the unit ~45s later with zero other symptoms — which is exactly
// the failure signature this module must never hide. Rate-limit so a
// persistently broken channel cannot flood the journal.
const NOTIFY_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastNotifyFailureLoggedMs = 0;

function logNotifyFailureThrottled(error) {
  const now = Date.now();
  if (now - lastNotifyFailureLoggedMs < NOTIFY_FAILURE_LOG_INTERVAL_MS) return;
  lastNotifyFailureLoggedMs = now;
  console.error(`[systemd-notify] notify fd write failed: ${error}`);
}

export function sendNotifyViaFd(fd, message) {
  try {
    writeSync(fd, message);
    return { skipped: false, via: 'fd' };
  } catch (error) {
    if (error?.code === 'EAGAIN') {
      try {
        writeSync(fd, message);
        return { skipped: false, via: 'fd', retried: true };
      } catch (retryError) {
        return {
          skipped: false,
          via: 'fd',
          error: trimString(retryError?.message) || 'notify fd write failed',
        };
      }
    }
    return {
      skipped: false,
      via: 'fd',
      error: trimString(error?.message) || 'notify fd write failed',
    };
  }
}

export function resolveWatchdogIntervalMs(env = process.env) {
  const usec = Number.parseInt(trimString(env.WATCHDOG_USEC), 10);
  if (!Number.isFinite(usec) || usec <= 0) return 15_000;
  return Math.max(1_000, Math.floor(usec / 2000));
}

export function buildSystemdNotifyArgs(fields = {}) {
  const args = [];
  if (fields.ready === true) args.push('--ready');
  if (trimString(fields.status)) args.push(`--status=${trimString(fields.status)}`);
  if (fields.watchdog === true) args.push('WATCHDOG=1');
  return args;
}

export async function systemdNotify(fields = {}, options = {}) {
  const env = options.env || process.env;
  if (!isSystemdNotifyAvailable(env)) return { skipped: true, reason: 'NOTIFY_SOCKET missing' };
  const message = buildNotifyMessage(fields);
  if (!message) return { skipped: true, reason: 'empty notification' };
  // Direct write from this pid (preferred: keeps the unit eligible for
  // NotifyAccess=main). The CLI child is only the fallback for environments
  // without the notify-exec wrapper.
  const fd = resolveNotifyFd(env);
  if (fd !== null) {
    const result = sendNotifyViaFd(fd, message);
    if (result.error) logNotifyFailureThrottled(result.error);
    return result;
  }
  const command = trimString(options.command) || DEFAULT_NOTIFY_COMMAND;
  const args = buildSystemdNotifyArgs(fields);
  try {
    await execFileAsync(command, args, {
      env,
      timeout: Number.isInteger(options.timeoutMs) ? options.timeoutMs : 2_000,
      maxBuffer: 64 * 1024,
    });
    return { skipped: false };
  } catch (error) {
    return {
      skipped: false,
      error: trimString(error?.message) || 'systemd-notify failed',
    };
  }
}

export function startSystemdWatchdog(options = {}) {
  const env = options.env || process.env;
  if (!isSystemdNotifyAvailable(env)) return { active: false, stop() {} };
  const intervalMs = Number.isInteger(options.intervalMs)
    ? options.intervalMs
    : resolveWatchdogIntervalMs(env);
  const statusProvider = typeof options.status === 'function' ? options.status : () => 'Ragent chat server healthy';
  const observe = typeof options.onHeartbeat === 'function' ? options.onHeartbeat : () => {};
  const report = (event) => { try { observe(event); } catch {} };
  let sequence = 0;
  let scheduledMonotonicMs = performance.now();
  const tick = () => {
    const actualMonotonicMs = performance.now();
    const startedAtMs = Date.now();
    const event = {
      sequence: ++sequence,
      scheduledAtMs: Math.round(startedAtMs - (actualMonotonicMs - scheduledMonotonicMs)),
      startedAtMs,
      delayMs: Math.max(0, Math.round(actualMonotonicMs - scheduledMonotonicMs)),
      result: 'pending',
    };
    // setInterval schedules its next callback from this turn, including after
    // a stalled loop; use monotonic time so wall-clock corrections do not
    // masquerade as scheduler delays.
    scheduledMonotonicMs = actualMonotonicMs + intervalMs;
    report({ ...event });
    void systemdNotify({ watchdog: true, status: statusProvider() }, options).then((result) => {
      // Error messages may contain command arguments; retain only known errno
      // codes, never the message or notification status text.
      const errorCode = typeof result.error === 'string'
        ? result.error.match(/\b(EBADF|EAGAIN|EPIPE|ENOTSOCK|ECONNREFUSED|ENOENT|EACCES|EPERM|ETIMEDOUT)\b/)?.[1]
        : null;
      report({ ...event, completedAtMs: Date.now(), durationMs: Math.max(0, Math.round(performance.now() - actualMonotonicMs)),
        result: result.skipped ? 'skipped' : result.error ? 'error' : 'sent',
        via: result.via === 'fd' ? 'fd' : 'command',
        ...(result.retried ? { retried: true } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    active: true,
    intervalMs,
    stop() {
      clearInterval(timer);
    },
  };
}
