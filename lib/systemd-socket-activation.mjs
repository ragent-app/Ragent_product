// P2-C: systemd socket-activation support for the runner services.
//
// systemd owns the listening socket (`.socket` unit) so it survives daemon
// restarts — the control plane never sees an ECONNREFUSED window during a
// `Restart=always` supervisor restart — and the socket file is created with
// declarative SocketUser/SocketGroup/SocketMode instead of by the daemon.
//
// When a service lists `Sockets=` in its unit, systemd passes the already
// bound+listening socket fds to the process starting at SD_LISTEN_FDS_START
// (3), and sets LISTEN_PID/LISTEN_FDS/LISTEN_FDNAMES in the child environment.
// The daemon must claim its fd by index in LISTEN_FDNAMES, never by guessing.
// If the fds were not inherited (LISTEN_PID mismatch, wrong name, or no
// LISTEN_FDS at all), the daemon falls back to creating its own socket — the
// pre-activation behaviour, so the code path works unchanged under a plain
// `Type=simple` launch.
//
// This module is side-effect free and env-driven, so both the supervisor and
// the lifecycle broker share it and it is trivially unit-testable.

export const SD_LISTEN_FDS_START = 3;

export const RUNNER_SUPERVISOR_SOCKET_UNIT = 'ragent-runner-supervisor.socket';
export const RUNNER_LIFECYCLE_SOCKET_UNIT = 'ragent-runner-lifecycle.socket';

/**
 * Detect a socket fd inherited from systemd.
 *
 * @param {object} [options]
 * @param {string} [options.expectedName]   The `.socket` unit name this daemon
 *   is the service for (e.g. RUNNER_SUPERVISOR_SOCKET_UNIT).  Required to claim
 *   a specific fd when LISTEN_FDNAMES is present; when it is absent (older
 *   systemd) the first fd is claimed.
 * @param {object} [options.env]            Environment to read (default process.env).
 * @param {number} [options.pid]            Process id to match LISTEN_PID against.
 * @returns {{ fd: number, count: number, name: string } | null}
 *   The inherited fd (starting at 3), the number of inherited fds, and the
 *   matched unit name, or null when no fd was passed for this service.
 */
export function inheritedSocketFd({
  expectedName = '',
  env = process.env,
  pid = typeof process.pid === 'number' ? process.pid : 0,
} = {}) {
  const listenPid = Number.parseInt(env.LISTEN_PID || '', 10);
  const listenFds = Number.parseInt(env.LISTEN_FDS || '', 10);
  if (!Number.isInteger(listenPid) || !Number.isInteger(listenFds)) return null;
  if (listenPid !== pid || listenFds < 1) return null;

  const names = String(env.LISTEN_FDNAMES || '')
    .split(':')
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length > 0) {
    // systemd v237+: LISTEN_FDNAMES lists the socket unit names in fd order.
    if (!expectedName) return null; // names present but no way to claim safely
    const index = names.indexOf(expectedName);
    if (index === -1 || index >= listenFds) return null;
    return { fd: SD_LISTEN_FDS_START + index, count: listenFds, name: expectedName };
  }

  // Older systemd: single-socket services just get fd 3.
  return { fd: SD_LISTEN_FDS_START, count: listenFds, name: expectedName };
}
