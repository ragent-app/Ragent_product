// Platform-managed provider process spawn.
//
// Linux semantic (unchanged): a provider CLI is launched with child_process
// spawn, explicit executable + argv + cwd + env, no shell.  Kill semantics are
// POSIX process-group based (process.kill(-pid)) where the caller created a
// detached group, else a direct signal to the root process.
//
// Windows semantic: every managed provider process must live inside a Job
// Object with KILL_ON_JOB_CLOSE, created via the suspended-create-assign-
// resume primitive, so cancel/timeout terminates the whole process tree.  A
// plain detached-process fallback is forbidden: when the Job Object host is
// unavailable on win32 the spawn fails closed instead.
//
// This module is the single place that knows about the Job Object wiring for
// one-shot control-plane provider invocations (fork probes, model listings,
// OAuth login helpers, summarizer prompts, detached assistant prompts).  The
// run sidecar keeps its own long-lived wiring and is NOT routed through here.

import { spawn } from 'child_process';
import { createWindowsJobObject, isWindowsJobObjectSupported } from './windows-job-object.mjs';
import { buildPlatformSpawnSpec } from './executable-resolution.mjs';

function stdioEntryIsIgnored(stdio, index) {
  if (stdio === 'ignore') return true;
  return Array.isArray(stdio) && stdio[index] === 'ignore';
}

export function isWindowsManagedSpawnPlatform(platform = process.platform) {
  return isWindowsJobObjectSupported(platform);
}

export function assertWindowsManagedJob(job, { platform = process.platform } = {}) {
  if (platform === 'win32' && !job) {
    const error = new Error(
      'Windows managed provider spawn requires a Job Object host; refusing plain spawn fallback',
    );
    error.code = 'WINDOWS_MANAGED_SPAWN_UNAVAILABLE';
    throw error;
  }
  return job;
}

function assertNoShell(spec, { platform }) {
  if (spec?.shell === true) {
    throw new Error(
      isWindowsManagedSpawnPlatform(platform)
        ? 'Windows managed provider spawn refuses shell:true'
        : 'Managed provider spawn refuses shell:true',
    );
  }
}

async function spawnPosix(spec, options) {
  return spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: options.stdio,
    ...(options.detached === true ? { detached: true } : {}),
  });
}

// Windows managed path.  Each one-shot invocation gets its own Job Object host
// so tree closure is independent of any other run, and the host is released as
// soon as the process reaches a terminal state.
async function spawnWindowsManaged(spec, options, deps = {}) {
  const createJob = deps.createWindowsJobObject || createWindowsJobObject;
  const job = await createJob({
    preserveOnControllerExit: options.preserveOnControllerExit === true,
  });
  if (!job) {
    // Fail closed: never fall back to a plain spawn on win32.
    assertWindowsManagedJob(job, { platform: 'win32' });
  }
  let proc;
  try {
    if (options.assertAuthorization) await options.assertAuthorization();
    proc = await job.createProcess({
      file: spec.file,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
      stdin: !stdioEntryIsIgnored(options.stdio, 0),
      stdout: !stdioEntryIsIgnored(options.stdio, 1),
      stderr: !stdioEntryIsIgnored(options.stdio, 2),
    });
  } catch (error) {
    try { await job.terminate(0xC0DE); } catch {}
    try { await job.close(); } catch {}
    throw error;
  }
  proc.__ragentWindowsManaged = true;
  proc.__ragentWindowsJobObjectCreation = 'suspended-create-assign-resume';
  // Read-only live diagnostics for native acceptance harnesses. Do not expose
  // the mutable Job object itself; callers can only observe current membership.
  proc.__ragentWindowsJobList = () => job.list();
  // The facade mirrors ChildProcess: stdout/stderr are PassThrough streams and
  // 'exit' arrives via the host's WaitLoop.  Release the dedicated host once
  // the process is terminal so the PowerShell helper does not outlive the work.
  proc.once('exit', () => {
    void job.close().catch(() => {});
  });
  return proc;
}

/**
 * Spawn a provider process from a resolved platform spawn spec.
 *
 * On POSIX this is a direct child_process.spawn with the same explicit
 * executable/argv/cwd/env contract.  On win32 the process is created inside a
 * dedicated Job Object (suspended-create-assign-resume, KILL_ON_JOB_CLOSE).
 *
 * The returned object follows the ChildProcess shape used by callers:
 * stdin/stdout/stderr streams, pid, 'exit'/'error' events, and kill().
 * On win32 kill() terminates the entire job (process tree), not just the root.
 */
export async function spawnManagedProviderProcess(spec, options = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  assertNoShell(spec, { platform });
  if (!isWindowsManagedSpawnPlatform(platform)) {
    if (options.assertAuthorization) await options.assertAuthorization();
    return spawnPosix(spec, options);
  }
  return spawnWindowsManaged(spec, options, deps);
}

// Managed Process Control uses the same lifecycle contract even though its
// child is not an AI provider. Keep the provider-named entry point for the
// existing call sites and expose the neutral name for other long-lived
// controlled children.
export function spawnManagedProcess(spec, options = {}, deps = {}) {
  return spawnManagedProviderProcess(spec, options, deps);
}

// Managed Process manifests keep the caller-facing executable and argv.  Turn
// Windows script executables into the same fixed platform spawn spec used by
// provider commands immediately before launch; POSIX fields pass through.
export function buildManagedProcessSpawnSpec({ file, args = [], cwd, env } = {}) {
  return buildPlatformSpawnSpec(file, args, { cwd, env });
}

/**
 * Terminate a provider process tree.
 *
 * Managed win32 process: TerminateJobObject via the facade's kill() (SIGKILL
 * and SIGTERM both map to whole-job termination — cooperative cancel is the
 * caller's business, this is the hard-closure primitive).
 *
 * POSIX detached group: signal the process group first (the semantic the
 * callers previously implemented inline), falling back to the root pid.
 */
export function terminateProviderProcessTree(proc, signal = 'SIGTERM') {
  if (!proc) return false;
  // On POSIX, detached providers own a process group. Signal that group
  // before falling back to the root ChildProcess so tool grandchildren do not
  // survive a timeout/cancel. On win32 the facade's kill() is the whole-job
  // primitive and must remain the first path.
  if (process.platform !== 'win32' && Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {}
  }
  if (process.platform === 'win32' && proc.__ragentWindowsManaged !== true
    && Number.isInteger(proc.pid) && proc.pid > 0) {
    try { proc.kill(signal); } catch {}
    try {
      // Non-Job Windows services (for example a locally spawned OpenHands
      // Agent Server) need taskkill's tree flag to close grandchildren.
      const taskkill = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      taskkill.unref?.();
      return true;
    } catch {}
  }
  if (typeof proc.kill === 'function') {
    // win32 facade kill() already terminates the whole job regardless of the
    // requested signal.
    const killed = proc.kill(signal);
    if (killed) return true;
  }
  if (Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {}
  }
  return false;
}

export function terminateManagedProcessTree(proc, signal = 'SIGTERM') {
  return terminateProviderProcessTree(proc, signal);
}
