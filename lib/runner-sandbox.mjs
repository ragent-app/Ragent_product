// P2-B: bubblewrap runner sandbox adapter.
//
// Wraps the tool process a Run launches in a bubblewrap mount/pid namespace:
//   - the whole root is read-only; only the run workspace and the runner home
//     (which holds the provider credential homes) are bound read-write
//   - /tmp and /run are private tmpfs; /proc and /dev are fresh
//   - PID / IPC / UTS namespace isolation
//   - control-plane paths (/var/lib/agentoc/config, /etc/agentoc) are hidden by
//     binding an empty directory over them, so a Run cannot see the control
//     core even if host file permissions were misconfigured
//
// This is defense-in-depth ON TOP of P0-B/P0-C: the runner already runs as a
// dedicated low-privilege user with no config access and a stripped
// environment.  The sandbox is OFF by default; enable it per-instance with
// AGENTOC_RUN_SANDBOX=1 (or any non-empty value). When the flag is unset,
// runs use the ordinary command. An explicit request must never silently
// fall back to an unsandboxed command.
//
// The module is side-effect free except for the one empty dir it creates to
// hide control-plane paths; the caller removes it after the run.

import { existsSync, lstatSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

export const RUNNER_SANDBOX_ENV = 'AGENTOC_RUN_SANDBOX';

// A provider's PATH may contain writable directories. Resolve neither the
// security boundary nor its version probe through that PATH.
export const TRUSTED_BWRAP_PATH = '/usr/bin/bwrap';

/** Probe only a root-owned, non-writable system binary and parent directories. */
export function isBwrapPresent({ stat = lstatSync, exec = execFileSync } = {}) {
  try {
    for (const [name, kind] of [['/', 'dir'], ['/usr', 'dir'], ['/usr/bin', 'dir'], [TRUSTED_BWRAP_PATH, 'file']]) {
      const entry = stat(name);
      if (entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0
          || (kind === 'dir' ? !entry.isDirectory() : !entry.isFile())) return false;
    }
    exec(TRUSTED_BWRAP_PATH, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** True when the trusted runner environment explicitly requests isolation. */
export function isSandboxRequested({ env = process.env } = {}) {
  const mode = String(env[RUNNER_SANDBOX_ENV] || '').trim().toLowerCase();
  return Boolean(mode && !['0', 'false', 'off', 'none', 'no'].includes(mode));
}

/** Availability probe; this does not authorize fallback when requested. */
export function isSandboxAvailable({ env = process.env, platform = process.platform, bwrapPresent = isBwrapPresent } = {}) {
  return platform === 'linux' && isSandboxRequested({ env }) && bwrapPresent();
}

/** Fail closed if a configured sandbox cannot be built on this host. */
export function requireSandboxAvailability({ env = process.env, platform = process.platform, required = false, bwrapPresent = isBwrapPresent } = {}) {
  if (!required && !isSandboxRequested({ env })) return false;
  if (platform !== 'linux' || !bwrapPresent()) {
    throw Object.assign(new Error('The configured runner sandbox is unavailable; refusing an unsandboxed run'), {
      code: 'RUNNER_SANDBOX_UNAVAILABLE',
    });
  }
  return true;
}

/**
 * Build the bubblewrap argv for a sandboxed tool spawn. Exported separately so
 * the arg construction can be asserted (and the S12 read-only variant reused)
 * without creating a temp hide-dir.
 *
 * @param {object} input
 * @param {string} input.command      absolute tool command path
 * @param {string[]} [input.args]     tool arguments
 * @param {string} input.cwd          run workspace (bound read-write by
 *                                    default; bound read-only when
 *                                    readOnly=true)
 * @param {string} input.runnerHome   runner state root (bound read-write outside read-only mode; it is a private runtime home,
 *                                    never the canonical workspace)
 * @param {string[]} [input.hidePaths] absolute control-plane paths to hide
 * @param {string} [input.emptyDir]    empty dir used to hide control-plane
 *                                    paths (created by buildSandboxedSpawn)
 * @param {boolean} [input.readOnly]   true => mount the run workspace with
 *                                    --ro-bind, refusing writes to the
 *                                    canonical workspace (S12 reviewer)
 * @returns {string[]} bwrap argv
 */
export function buildBwrapArgs({
  command,
  args = [],
  cwd = '',
  runnerHome = '',
  hidePaths = [],
  emptyDir = '',
  readOnly = false,
  bindReadOnlyPaths = [],
  exposeHostDevices = false,
}) {
  const bwrapArgs = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--proc', '/proc',
    ...(exposeHostDevices ? ['--dev-bind', '/dev', '/dev'] : ['--dev', '/dev']),
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
  ];
  // Only bind paths that actually exist: bwrap cannot create a mountpoint
  // under a read-only parent, so a missing runner home would abort the launch.
  if (cwd && existsSync(cwd)) {
    bwrapArgs.push(readOnly ? '--ro-bind' : '--bind', cwd, cwd);
  }
  // A writable home can expose hard links or alternate workspace paths.
  // Read-only runs keep the host filesystem read-only, with private tmpfs.
  if (!readOnly && runnerHome && existsSync(runnerHome)) bwrapArgs.push('--bind', runnerHome, runnerHome);
  // Apply GUI binds after workspace/home mounts so an Xauthority or runtime
  // path inside an otherwise writable user tree remains read-only. Keep the
  // control-plane overlays last so a hostile GUI path cannot reopen a hidden
  // config subtree.
  for (const path of bindReadOnlyPaths) {
    if (path && existsSync(path)) bwrapArgs.push('--ro-bind', path, path);
  }
  for (const path of hidePaths) {
    if (path && emptyDir) bwrapArgs.push('--bind', emptyDir, path);
  }
  bwrapArgs.push('--');
  bwrapArgs.push(command, ...args);
  return bwrapArgs;
}

/**
 * Wrap a tool invocation in bubblewrap.  Returns the sandboxed argv plus a
 * temp empty dir used to hide control-plane paths (caller removes it).
 *
 * @param {object} input
 * @param {string} input.command      absolute tool command path
 * @param {string[]} [input.args]     tool arguments
 * @param {string} input.cwd          run workspace (bound read-write by
 *                                    default; bound read-only when
 *                                    readOnly=true)
 * @param {string} input.runnerHome   runner state root (bound read-write; holds
 *                                    the provider credential homes + HOME)
 * @param {string[]} [input.hidePaths] absolute control-plane paths to hide
 * @param {boolean} [input.readOnly]   true => mount the run workspace with
 *                                    --ro-bind (S12 reviewer variant)
 * @returns {{command:string, args:string[], sandboxed:boolean, emptyDir:string}}
 */
export function buildSandboxedSpawn({
  command,
  args = [],
  cwd = '',
  runnerHome = '',
  hidePaths = [],
  readOnly = false,
  bindReadOnlyPaths = [],
  exposeHostDevices = false,
  mkdtemp = mkdtempSync,
}) {
  const emptyDir = mkdtemp(join(tmpdir(), 'agentoc-sandbox-hide-'));
  const bwrapArgs = buildBwrapArgs({
    command,
    args,
    cwd,
    runnerHome,
    hidePaths,
    emptyDir,
    readOnly,
    bindReadOnlyPaths,
    exposeHostDevices,
  });
  return { command: TRUSTED_BWRAP_PATH, args: bwrapArgs, sandboxed: true, emptyDir };
}
