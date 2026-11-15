#!/usr/bin/env node
/**
 * Adversarial acceptance I-3 / I-4: the winget/msiexec executable path is
 * server-owned configuration. A worker must not be able to change it via env,
 * CLI, or request payload, and a deployment override must be an absolute
 * Windows path (rejected otherwise, fail-closed).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RUNNER_ENV_ALLOWLIST, pickRunnerEnvAllowlist } from '../lib/runner-env.mjs';
import { buildWindowsWingetInstallInvocation, WINGET_EXECUTABLE } from '../chat/semantic-windows-adapter.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

// ── I-3 env: a worker's RAGENT_WINGET_EXECUTABLE never reaches a Run ─────────
check('runner env allowlist does not carry RAGENT_WINGET_EXECUTABLE',
  !RUNNER_ENV_ALLOWLIST.includes('RAGENT_WINGET_EXECUTABLE'));
check('runner env allowlist does not carry RAGENT_MSIEXEC_EXECUTABLE',
  !RUNNER_ENV_ALLOWLIST.includes('RAGENT_MSIEXEC_EXECUTABLE'));
const picked = pickRunnerEnvAllowlist({
  RAGENT_WINGET_EXECUTABLE: 'C:\\evil\\winget.exe',
  RAGENT_MSIEXEC_EXECUTABLE: 'C:\\evil\\msiexec.exe',
  PATH: 'C:\\Windows\\System32',
  HOME: 'C:\\Users\\x',
});
check('allowlist pick strips a worker-set RAGENT_WINGET_EXECUTABLE', picked.RAGENT_WINGET_EXECUTABLE === undefined);
check('allowlist pick strips a worker-set RAGENT_MSIEXEC_EXECUTABLE', picked.RAGENT_MSIEXEC_EXECUTABLE === undefined);
const osEnv = pickRunnerEnvAllowlist({ SystemRoot: 'D:\\WinNT', WINDIR: 'D:\\WinNT', USERPROFILE: 'E:\\Users\\owner',
  LOCALAPPDATA: 'E:\\Users\\owner\\AppData\\Local', APPDATA: 'E:\\Users\\owner\\AppData\\Roaming',
  TEMP: 'G:\\temp', TMP: 'G:\\temp', TMPDIR: 'G:\\temp', PATHEXT: '.EXE;.CMD', MY_SERVICE_TOKEN: 'secret' });
eq('alternate Windows root reaches the runner', osEnv.SystemRoot, 'D:\\WinNT');
eq('current user profile reaches the runner', osEnv.USERPROFILE, 'E:\\Users\\owner');
eq('current user local app data reaches the runner', osEnv.LOCALAPPDATA, 'E:\\Users\\owner\\AppData\\Local');
eq('configured temp stays on its chosen drive', osEnv.TEMP, 'G:\\temp');
eq('credential-shaped values still do not reach the runner', osEnv.MY_SERVICE_TOKEN, undefined);

// ── I-3 payload: a request can supply package semantics but never an executable
//    the winget builder derives the executable from the server constant, so a
//    forged adapterInput.executable field is ignored.
const forgedCapability = {
  adapter: 'windows-winget-install/v1',
  operations: [{
    platform: 'win32',
    primaryAction: 'package.install',
    executionClass: 'host',
    effects: ['process.execute'],
    adapterInput: {
      manager: 'winget',
      source: 'winget',
      requestedInstallScope: 'machine',
      exact: true,
      packages: ['Git.Git'],
      requestedVersions: [''],
      resolvedVersions: ['2.0'],
      sourceTrust: 'configured',
      executable: 'C:\\evil\\forged.exe', // must be ignored
      argv: ['--evil'],                   // must be ignored
    },
  }],
};
const invocation = buildWindowsWingetInstallInvocation(forgedCapability);
eq('invocation executable is the server constant, never the forged payload value',
  invocation.executable, WINGET_EXECUTABLE);
check('forged argv is ignored', !invocation.argv.includes('--evil'));

// ── I-4 override validation: absolute-path-only, fail closed at import ─────────
const importWith = (env) => {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', "import('./chat/semantic-windows-adapter.mjs')"], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, stderr: String(error?.stderr || '') };
  }
};
eq('relative override is rejected', importWith({ RAGENT_WINGET_EXECUTABLE: 'winget.exe' }).ok, false);
eq('UNC override is rejected', importWith({ RAGENT_WINGET_EXECUTABLE: '\\\\server\\share\\winget.exe' }).ok, false);
check('valid absolute override imports', importWith({ RAGENT_WINGET_EXECUTABLE: 'C:\\Tools\\winget.exe' }).ok === true);
const previousSystemRoot = process.env.SystemRoot;
const previousMsiexec = process.env.RAGENT_MSIEXEC_EXECUTABLE;
let alternateAdapter; let alternateFacts;
try {
  process.env.SystemRoot = 'D:\\WinNT';
  delete process.env.RAGENT_MSIEXEC_EXECUTABLE;
  alternateAdapter = await import('../chat/semantic-windows-adapter.mjs?alternate-root');
  alternateFacts = await import('../chat/windows-runtime-facts-provider.mjs?alternate-root');
} finally {
  if (previousSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previousSystemRoot;
  if (previousMsiexec === undefined) delete process.env.RAGENT_MSIEXEC_EXECUTABLE; else process.env.RAGENT_MSIEXEC_EXECUTABLE = previousMsiexec;
}
eq('msiexec follows an alternate system root', alternateAdapter.MSIEXEC_EXECUTABLE, 'D:\\WinNT\\System32\\msiexec.exe');
eq('facts provider follows an alternate system root', alternateFacts.WINDOWS_POWERSHELL_EXECUTABLE, 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');

console.log(`executor-executable-boundary: ${passed} checks passed`);
