#!/usr/bin/env node
// Windows managed provider spawn — platform contract tests.
//
// Off-win32 (Linux dev / CI): proves the POSIX passthrough keeps the exact
// child_process.spawn semantics the five migrated call sites relied on
// (explicit executable + argv + cwd + env, no shell, detached groups), and
// exercises the win32 managed path through injected fakes: shell refusal,
// fail-closed on missing Job host, spec passthrough, whole-tree terminate on
// kill, and host release after exit.  Nothing here pretends to be Windows
// live evidence; the real host traces live under
// /var/lib/ragent/workspace/windows-a0-evidence/.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  assertWindowsManagedJob,
  isWindowsManagedSpawnPlatform,
  spawnManagedProcess,
  spawnManagedProviderProcess,
  buildManagedProcessSpawnSpec,
  terminateManagedProcessTree,
  terminateProviderProcessTree,
} from '../lib/windows-managed-spawn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isPosixRuntime = process.platform !== 'win32';

let passed = 0;
let failed = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok - ${label}`);
  } else {
    failed += 1;
    console.error(`  NOT OK - ${label}${extra ? `: ${extra}` : ''}`);
  }
}

// --- Platform gate ------------------------------------------------------

ok('linux is not a managed-spawn platform',
  isWindowsManagedSpawnPlatform('linux') === false);
ok('win32 is a managed-spawn platform',
  isWindowsManagedSpawnPlatform('win32') === true);
ok('neutral managed-process entry point is available',
  typeof spawnManagedProcess === 'function');
ok('neutral managed-process terminate entry point is available',
  typeof terminateManagedProcessTree === 'function');
assert.throws(
  () => assertWindowsManagedJob(null, { platform: 'win32' }),
  (error) => error?.code === 'WINDOWS_MANAGED_SPAWN_UNAVAILABLE'
    && /refusing plain spawn fallback/.test(error.message),
);
ok('shared Windows Job assertion fails closed', true);
ok('shared Windows Job assertion preserves POSIX null',
  assertWindowsManagedJob(null, { platform: 'linux' }) === null);
const managedSpec = buildManagedProcessSpawnSpec({
  file: process.execPath,
  args: ['-e', 'process.exit(0)'],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH },
});
ok('neutral managed-process spawn spec preserves executable', managedSpec.file === process.execPath);
ok('neutral managed-process spawn spec preserves fixed argv',
  managedSpec.args[0] === '-e' && managedSpec.args[1] === 'process.exit(0)');
ok('neutral managed-process spawn spec disables shell', managedSpec.shell === false);

// --- POSIX passthrough: real child_process semantics --------------------

if (isPosixRuntime) {

{
  const proc = await spawnManagedProviderProcess({
    file: process.execPath,
    args: ['-e', 'process.stdout.write("posix-ok")'],
    cwd: here,
    env: { ...process.env, MANAGED_SPAWN_PROBE: '1' },
    shell: false,
  }, { stdio: ['pipe', 'pipe', 'pipe'] });

  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  ok('posix passthrough completes with exit 0', code === 0);
  ok('posix passthrough pipes stdout', out === 'posix-ok');
  ok('posix passthrough yields a real pid', Number.isInteger(proc.pid) && proc.pid > 0);
}

{
  // Detached spawn keeps the process-group semantics the detached assistant
  // timeout path depends on (process.kill(-pid) must remain valid).
  const proc = await spawnManagedProviderProcess({
    file: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("group-ok"), 50)'],
    cwd: here,
    env: process.env,
    shell: false,
  }, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });

  ok('posix detached passthrough spawns', Number.isInteger(proc.pid));
  let groupSignalWorked = false;
  try {
    process.kill(-proc.pid, 0);
    groupSignalWorked = true;
  } catch {}
  ok('posix detached passthrough creates a signalable process group', groupSignalWorked);
  await new Promise((resolve) => proc.on('exit', resolve));
}

}

// --- terminateProviderProcessTree: POSIX group semantics -----------------

if (isPosixRuntime) {

{
  // A two-level tree; killing the group must take down the child too.
  const proc = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    c.on('exit', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  await new Promise((resolve) => setTimeout(resolve, 400));
  const childAliveBefore = await isPidAlive(proc.pid);
  ok('posix tree root is alive before group kill', childAliveBefore === true);

  const killed = terminateProviderProcessTree(proc, 'SIGKILL');
  ok('posix group kill reports success', killed === true);
  await new Promise((resolve) => proc.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  ok('posix tree root is gone after group kill', (await isPidAlive(proc.pid)) === false);
}

}

// --- win32 managed path via fakes ----------------------------------------

function fakeJobHost({ createShouldFail = false } = {}) {
  const calls = [];
  let killCount = 0;
  const facade = new EventEmitter();
  facade.pid = 4242;
  facade.exitCode = null;
  facade.kill = (signal = 'SIGTERM') => {
    killCount += 1;
    facade.killed = true;
    facade.exitCode = 1;
    facade.emit('exit', 1, null);
    return true;
  };
  const job = {
    calls,
    getKillCount: () => killCount,
    async createProcess(spec) {
      calls.push({ op: 'createProcess', spec });
      if (createShouldFail) throw new Error('create failed');
      return facade;
    },
    async terminate(code) {
      calls.push({ op: 'terminate', code });
    },
    async close() {
      calls.push({ op: 'close' });
    },
  };
  return { job, facade };
}

{
  // shell:true must be refused outright — the invariant that keeps provider
  // argv from becoming shell string.
  await assert.rejects(
    () => spawnManagedProviderProcess(
      { file: 'cmd', args: ['/c', 'echo hi'], shell: true },
      { stdio: ['pipe', 'pipe', 'pipe'] },
      { platform: 'win32' },
    ),
    /refuses shell:true/,
  );
  ok('win32 managed spawn refuses shell:true', true);
}

{
  // Missing Job host fails closed — no plain spawn fallback on win32.
  await assert.rejects(
    () => spawnManagedProviderProcess(
      { file: 'node.exe', args: ['-v'], shell: false },
      { stdio: ['pipe', 'pipe', 'pipe'] },
      { platform: 'win32', createWindowsJobObject: async () => null },
    ),
    /refusing plain spawn fallback/,
  );
  ok('win32 managed spawn fails closed without Job host', true);
}

{
  // Spec passthrough + stdio mapping + lifecycle.
  const { job, facade } = fakeJobHost({});
  let createOptions = null;
  const proc = await spawnManagedProviderProcess(
    {
      file: 'C:\\repo\\codex.cmd',
      args: ['app-server', '--stdio'],
      cwd: 'C:\\work',
      env: { PATH: 'C:\\bin' },
      windowsVerbatimArguments: true,
      shell: false,
    },
    { stdio: ['pipe', 'pipe', 'pipe'] },
    {
      platform: 'win32',
      createWindowsJobObject: async (options) => {
        createOptions = options;
        return job;
      },
    },
  );

  const create = job.calls.find((c) => c.op === 'createProcess');
  ok('win32 managed spawn passes explicit file', create.spec.file === 'C:\\repo\\codex.cmd');
  ok('win32 managed spawn passes fixed argv', JSON.stringify(create.spec.args) === JSON.stringify(['app-server', '--stdio']));
  ok('win32 managed spawn passes cwd', create.spec.cwd === 'C:\\work');
  ok('win32 managed spawn passes env', create.spec.env?.PATH === 'C:\\bin');
  ok('win32 managed spawn forwards verbatim argv flag', create.spec.windowsVerbatimArguments === true);
  ok('win32 managed spawn opens all three pipes',
    create.spec.stdin === true && create.spec.stdout === true && create.spec.stderr === true);
  ok('win32 managed spawn returns the job facade', proc === facade);
  ok('win32 managed spawn exposes read-only job membership diagnostics',
    typeof proc.__ragentWindowsJobList === 'function');
  ok('win32 managed spawn defaults to controller-owned Job cleanup', createOptions?.preserveOnControllerExit === false);

  // Natural exit must release the dedicated host.
  facade.emit('exit', 0, null);
  await new Promise((r) => setTimeout(r, 10));
  ok('win32 managed spawn closes job host after exit', job.calls.some((c) => c.op === 'close'));
}

{
  const { job } = fakeJobHost({});
  let createOptions = null;
  const facade = await spawnManagedProcess(
    { file: 'quiet.exe', args: [], shell: false },
    { stdio: 'ignore' },
    {
      platform: 'win32',
      createWindowsJobObject: async (options) => {
        createOptions = options;
        return job;
      },
    },
  );
  const create = job.calls.find((c) => c.op === 'createProcess');
  ok('win32 string stdio ignore disables all managed pipes',
    create.spec.stdin === false && create.spec.stdout === false && create.spec.stderr === false);
  ok('win32 string stdio ignore keeps default controller-owned cleanup', createOptions?.preserveOnControllerExit === false);
  facade.emit('exit', 0, null);
}

{
  const { job, facade } = fakeJobHost({});
  let createOptions = null;
  await spawnManagedProcess(
    { file: 'managed.exe', args: [], shell: false },
    { stdio: ['ignore', 'pipe', 'pipe'], preserveOnControllerExit: true },
    {
      platform: 'win32',
      createWindowsJobObject: async (options) => {
        createOptions = options;
        return job;
      },
    },
  );
  ok('neutral managed-process path opts into controller-EOF preservation', createOptions?.preserveOnControllerExit === true);
  facade.emit('exit', 0, null);
}

{
  // createProcess failure must tear the job down, not leak it.
  const { job } = fakeJobHost({ createShouldFail: true });
  await assert.rejects(
    () => spawnManagedProviderProcess(
      { file: 'x.exe', args: [], shell: false },
      { stdio: ['pipe', 'pipe', 'pipe'] },
      { platform: 'win32', createWindowsJobObject: async () => job },
    ),
    /create failed/,
  );
  ok('win32 managed spawn terminates job on create failure',
    job.calls.some((c) => c.op === 'terminate'));
  ok('win32 managed spawn closes job on create failure',
    job.calls.some((c) => c.op === 'close'));
}

{
  // kill() on the facade must terminate the whole job (tree closure), and
  // terminateProviderProcessTree must route through it.
  const { job, facade } = fakeJobHost({});
  const proc = await spawnManagedProviderProcess(
    { file: 'x.exe', args: [], shell: false },
    { stdio: ['pipe', 'pipe', 'pipe'] },
    { platform: 'win32', createWindowsJobObject: async () => job },
  );
  const killed = terminateProviderProcessTree(proc, 'SIGTERM');
  ok('win32 tree terminate reports success', killed === true);
  ok('win32 tree terminate invoked job kill', facade.killed === true);
}

// --- helpers --------------------------------------------------------------

async function isPidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

console.log(`test-windows-managed-spawn: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
